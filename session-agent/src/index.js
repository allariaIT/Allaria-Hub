import 'dotenv/config'
import express from 'express'
import { runAgent } from './agent.js'
import { gitClone, gitCommitAndPush } from './git.js'

const app = express()
app.use(express.json({ limit: '10mb' }))

const PORT = process.env.PORT || 3200
const WORKSPACE = process.env.WORKSPACE_DIR || '/workspace'
const REPO_URL = process.env.REPO_URL
const SESSION_ID = process.env.SESSION_ID
const BACK_URL = process.env.BACK_URL

const SYSTEM_PROMPT = `Sos el asistente de desarrollo de este proyecto web.

REGLA CRÍTICA — NUNCA respondas con solo texto cuando tenés que hacer algo. Llamá las herramientas directamente sin anunciar primero lo que vas a hacer. Si necesitás ver un archivo, llamá read_file ahora mismo. Si necesitás modificar algo, llamá write_file. No describas el plan — ejecutalo.

REGLA FUNDAMENTAL — SIN EXCEPCIONES:
Nunca digas "listo", "hecho" ni des por completada ninguna tarea sin haber ejecutado el flujo completo incluyendo git_push.

FLUJO OBLIGATORIO para cualquier modificación:
1. read_file — Leé el archivo actual antes de modificar. Para archivos grandes usá offset para leer por partes.
2. write_file — Escribí el archivo completo con los cambios aplicados
3. git_push — Commitea y pushea los cambios. El CI de GitLab buildea y deploya automáticamente.
4. Confirmá al usuario: "✅ Pusheado. El CI está desplegando (~5min). Podés verlo en la preview."

HERRAMIENTAS DISPONIBLES:
- read_file(path, offset?, limit?) — leer un archivo. Para archivos de más de 150 líneas, el resultado incluye nextOffset para leer la siguiente parte.
- write_file(path, content) — escribir un archivo completo
- list_files() — ver estructura del proyecto
- bash(cmd) — ejecutar npm install, npm run, etc.
- git_push(message) — commitear y pushear todos los cambios

REGLAS ADICIONALES:
- Para instalar librerías: bash("npm install <paquete>") → write_file → git_push
- Si el usuario dice "continuá" o "seguí", leé CHANGELOG.md para retomar el contexto
- Actualizá CHANGELOG.md con fecha y descripción de cada cambio importante
- NO creés proyectos nuevos. Solo trabajás dentro del proyecto activo.
- NUNCA modifiques el campo \`base\` en vite.config.js — ese valor es generado por el sistema de deploy y es crítico para que la app funcione bajo su sub-path en K8s. Si lo cambiás, la app queda en blanco.`

// Estado de inactividad
let lastActivity = Date.now()
const IDLE_TIMEOUT_MS = 60 * 60 * 1000 // 60 min
let shuttingDown = false
let server

// GET /health
app.get('/health', (req, res) => {
  const idleSince = Date.now() - lastActivity
  res.json({
    status: 'ok',
    sessionId: SESSION_ID,
    idleSinceMs: idleSince,
  })
})

// POST /chat → SSE stream
app.post('/chat', async (req, res) => {
  const { message, history = [] } = req.body

  if (!message) return res.status(400).json({ error: 'message es requerido' })

  lastActivity = Date.now()

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  const send = (obj) => {
    try { res.write(`data: ${JSON.stringify(obj)}\n\n`) } catch {}
  }

  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n') } catch {}
  }, 15_000)

  try {
    send({ type: 'thinking' })

    let fullText = ''
    for await (const event of runAgent(message, history, SYSTEM_PROMPT)) {
      send(event)
      if (event.type === 'text') fullText += event.content
    }

    send({ type: 'done', content: fullText })
  } catch (err) {
    send({ type: 'error', message: err.message })
  } finally {
    clearInterval(heartbeat)
    res.end()
  }
})

// Shutdown graceful
async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  clearInterval(idleTimer)
  if (server) server.close()
  console.log(`[session-agent] ${signal} recibido — iniciando shutdown`)
  try {
    const result = gitCommitAndPush(WORKSPACE, 'session end: auto-push')
    if (result.pushed) console.log(`[session-agent] Auto-push OK: ${result.commit}`)
  } catch (err) {
    console.warn('[session-agent] Auto-push falló:', err.message)
  }

  if (BACK_URL && SESSION_ID) {
    try {
      await fetch(`${BACK_URL}/api/internal/sessions/${SESSION_ID}/end`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ summary: 'Sesión finalizada por inactividad' }),
        signal: AbortSignal.timeout(5000),
      })
    } catch {}
  }

  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

// Idle watcher: verifica inactividad cada 5 min
const idleTimer = setInterval(() => {
  if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
    console.log('[session-agent] Inactividad detectada — iniciando shutdown')
    shutdown('IDLE')
  }
}, 5 * 60_000)

// Startup: clonar repo
async function start() {
  if (REPO_URL) {
    console.log(`[session-agent] Clonando ${REPO_URL}...`)
    try {
      gitClone(REPO_URL, WORKSPACE)
      console.log('[session-agent] Repo listo')
    } catch (err) {
      console.error('[session-agent] Error clonando repo:', err.message)
      process.exit(1)
    }
  }

  server = app.listen(PORT, () => {
    console.log(`[session-agent] Running on port ${PORT} — session ${SESSION_ID}`)
  })
}

start()
