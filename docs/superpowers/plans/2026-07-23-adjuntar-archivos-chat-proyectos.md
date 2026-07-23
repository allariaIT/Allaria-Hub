# Adjuntar archivos al chat de Proyectos — Plan de Implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir adjuntar archivos en el chat del workspace de un proyecto para que el agente de desarrollo los materialice en el repo, vea las imágenes/PDF y use los datos/specs al desarrollar.

**Architecture:** Enfoque híbrido. El front lee los archivos (base64 para binarios, texto para archivos de texto) y los manda como campo `attachments` aparte del mensaje. El back los reenvía al pod. El pod los escribe en `/workspace/.attachments/` (quedan en el repo al hacer `git_push`) y arma el mensaje del agente incluyendo las imágenes/PDF como `image_url` y una nota con las rutas de todos los adjuntos.

**Tech Stack:** React 19 (front), Express 5 + Prisma (back), Node 23 + Express 5 (session-agent, corriendo como pod en CCE). Tests: vitest (session-agent), node:test (back).

## Global Constraints

- Máx **5** archivos por mensaje; máx **10 MB** por archivo; máx **20 MB** en total.
- `accept` del input file (front): `image/*,audio/*,video/*,.pdf,.txt,.csv,.json,.md,.py,.js,.ts,.jsx,.tsx,.html,.css`.
- MIME que van al LLM como `image_url`: `image/jpeg`, `image/png`, `image/gif`, `image/webp`, `application/pdf`.
- Carpeta de materialización dentro del repo clonado: `.attachments/` (relativa a `WORKSPACE_DIR`, default `/workspace`).
- Límite `express.json`: back ya `50mb` (no tocar); pod `10mb` → `30mb`.
- Forma del objeto attachment que viaja front → back → pod: `{ name: string, type: string, base64?: string, textContent?: string }`. `base64` es un data URL (`data:<mime>;base64,<...>`). Cada adjunto trae **o** `base64` (binarios) **o** `textContent` (archivos de texto), nunca ambos.
- Idioma del código y los textos de UI: español (convención del repo).

---

## Task 1: session-agent — módulo `attachments.js` (materialización)

Escribe los adjuntos recibidos en `.attachments/` dentro del workspace, saneando nombres, bloqueando path traversal y resolviendo colisiones.

**Files:**
- Create: `session-agent/src/attachments.js`
- Test: `session-agent/src/__tests__/attachments.test.js`

**Interfaces:**
- Consumes: nada (usa `process.env.WORKSPACE_DIR`, igual que `tools.js`).
- Produces: `writeAttachments(attachments: Array<{name, type, base64?, textContent?}>) => Array<{ name: string, mimeType: string, path: string, base64?: string }>` — escribe cada archivo y devuelve la metadata (con la ruta relativa final ya resuelta por colisiones). `path` es del tipo `.attachments/<nombre>`. Preserva `base64` en el retorno para que Task 2 pueda armar los `image_url`.

- [ ] **Step 1: Write the failing test**

Crear `session-agent/src/__tests__/attachments.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

let tmpDir

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-test-'))
  process.env.WORKSPACE_DIR = tmpDir
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  delete process.env.WORKSPACE_DIR
  vi.resetModules()
})

async function getModule() {
  return await import('../attachments.js')
}

describe('writeAttachments', () => {
  it('devuelve [] con lista vacía o inválida', async () => {
    const { writeAttachments } = await getModule()
    expect(writeAttachments([])).toEqual([])
    expect(writeAttachments()).toEqual([])
  })

  it('escribe un archivo de texto en .attachments/', async () => {
    const { writeAttachments } = await getModule()
    const out = writeAttachments([{ name: 'datos.csv', type: 'text/csv', textContent: 'a,b\n1,2' }])
    expect(out).toHaveLength(1)
    expect(out[0].path).toBe('.attachments/datos.csv')
    const written = fs.readFileSync(path.join(tmpDir, '.attachments', 'datos.csv'), 'utf-8')
    expect(written).toBe('a,b\n1,2')
  })

  it('decodifica base64 de un data URL para binarios', async () => {
    const { writeAttachments } = await getModule()
    // "hola" en base64 = aG9sYQ==
    const dataUrl = 'data:image/png;base64,aG9sYQ=='
    const out = writeAttachments([{ name: 'logo.png', type: 'image/png', base64: dataUrl }])
    expect(out[0].base64).toBe(dataUrl)
    const buf = fs.readFileSync(path.join(tmpDir, '.attachments', 'logo.png'))
    expect(buf.toString('utf-8')).toBe('hola')
  })

  it('resuelve colisiones de nombre con sufijo -N', async () => {
    const { writeAttachments } = await getModule()
    const out = writeAttachments([
      { name: 'a.txt', type: 'text/plain', textContent: 'uno' },
      { name: 'a.txt', type: 'text/plain', textContent: 'dos' },
    ])
    expect(out[0].path).toBe('.attachments/a.txt')
    expect(out[1].path).toBe('.attachments/a-1.txt')
    expect(fs.readFileSync(path.join(tmpDir, '.attachments', 'a-1.txt'), 'utf-8')).toBe('dos')
  })

  it('sanea path traversal quedándose con el basename', async () => {
    const { writeAttachments } = await getModule()
    const out = writeAttachments([{ name: '../../etc/passwd', type: 'text/plain', textContent: 'x' }])
    expect(out[0].path).toBe('.attachments/passwd')
    expect(fs.existsSync(path.join(tmpDir, '.attachments', 'passwd'))).toBe(true)
  })

  it('saltea adjuntos sin contenido', async () => {
    const { writeAttachments } = await getModule()
    const out = writeAttachments([{ name: 'vacio.bin', type: 'application/octet-stream' }])
    expect(out).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd session-agent && npx vitest run src/__tests__/attachments.test.js`
Expected: FAIL — `Cannot find module '../attachments.js'`.

- [ ] **Step 3: Write minimal implementation**

Crear `session-agent/src/attachments.js`:

```js
import fs from 'node:fs'
import path from 'node:path'

const WORKSPACE = process.env.WORKSPACE_DIR || '/workspace'
const ATTACH_DIRNAME = '.attachments'

// Solo el basename, sin separadores ni prefijos relativos
function sanitizeName(name) {
  const base = path.basename(String(name ?? '').trim())
  const cleaned = base.replace(/[/\\]/g, '').replace(/^\.+/, '')
  return cleaned || 'archivo'
}

// Agrega -1, -2, ... antes de la extensión si el nombre ya existe
function uniqueName(dir, name) {
  const ext = path.extname(name)
  const stem = ext ? name.slice(0, -ext.length) : name
  let candidate = name
  let i = 1
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${stem}-${i}${ext}`
    i++
  }
  return candidate
}

// Extrae los bytes de un data URL (o base64 crudo)
function decodeBase64(b64) {
  const comma = b64.indexOf(',')
  const raw = b64.startsWith('data:') && comma !== -1 ? b64.slice(comma + 1) : b64
  return Buffer.from(raw, 'base64')
}

export function writeAttachments(attachments = []) {
  if (!Array.isArray(attachments) || attachments.length === 0) return []
  const dir = path.join(WORKSPACE, ATTACH_DIRNAME)
  fs.mkdirSync(dir, { recursive: true })

  const written = []
  for (const att of attachments) {
    try {
      const finalName = uniqueName(dir, sanitizeName(att.name))
      const dest = path.join(dir, finalName)
      if (!path.resolve(dest).startsWith(path.resolve(dir) + path.sep)) {
        console.warn(`[attachments] path inválido, se saltea: ${att.name}`)
        continue
      }
      if (typeof att.textContent === 'string') {
        fs.writeFileSync(dest, att.textContent, 'utf-8')
      } else if (typeof att.base64 === 'string') {
        fs.writeFileSync(dest, decodeBase64(att.base64))
      } else {
        console.warn(`[attachments] sin contenido, se saltea: ${att.name}`)
        continue
      }
      written.push({
        name: finalName,
        mimeType: att.type || '',
        path: `${ATTACH_DIRNAME}/${finalName}`,
        base64: typeof att.base64 === 'string' ? att.base64 : undefined,
      })
    } catch (err) {
      console.warn(`[attachments] error escribiendo ${att?.name}: ${err.message}`)
    }
  }
  return written
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd session-agent && npx vitest run src/__tests__/attachments.test.js`
Expected: PASS — 6 tests verdes.

- [ ] **Step 5: Commit**

```bash
git add session-agent/src/attachments.js session-agent/src/__tests__/attachments.test.js
git commit -m "feat(session-agent): materializar adjuntos en .attachments/"
```

---

## Task 2: session-agent — `buildUserContent` + wiring en `runAgent`

Arma el `content` del primer mensaje de usuario: texto del pedido + `image_url` para imágenes/PDF + una nota con las rutas de todos los adjuntos.

**Files:**
- Modify: `session-agent/src/agent.js` (agregar `buildUserContent` exportada; cambiar firma y construcción de `messages` en `runAgent`)
- Test: `session-agent/src/__tests__/build-user-content.test.js`

**Interfaces:**
- Consumes: el array que devuelve `writeAttachments` de Task 1 (`{ name, mimeType, path, base64? }`).
- Produces: `buildUserContent(userMessage: string, attachments = []) => string | Array<part>`. Devuelve el string tal cual si no hay adjuntos; si hay, devuelve un array de parts OpenAI-compat (`{type:'text'}` / `{type:'image_url', image_url:{url}}`). `runAgent(userMessage, history, systemPrompt, attachments = [])` — nueva firma con 4º parámetro.

- [ ] **Step 1: Write the failing test**

Crear `session-agent/src/__tests__/build-user-content.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { buildUserContent } from '../agent.js'

describe('buildUserContent', () => {
  it('sin adjuntos devuelve el mensaje como string', () => {
    expect(buildUserContent('hola', [])).toBe('hola')
    expect(buildUserContent('hola')).toBe('hola')
  })

  it('con imagen agrega image_url y una nota con la ruta', () => {
    const atts = [{ name: 'm.png', mimeType: 'image/png', path: '.attachments/m.png', base64: 'data:image/png;base64,AAA' }]
    const parts = buildUserContent('replicá esto', atts)
    expect(Array.isArray(parts)).toBe(true)
    expect(parts[0]).toEqual({ type: 'text', text: 'replicá esto' })
    expect(parts).toContainEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } })
    const note = parts[parts.length - 1]
    expect(note.type).toBe('text')
    expect(note.text).toContain('.attachments/m.png')
  })

  it('con csv (texto) no agrega image_url pero incluye la ruta en la nota', () => {
    const atts = [{ name: 'd.csv', mimeType: 'text/csv', path: '.attachments/d.csv' }]
    const parts = buildUserContent('usá estos datos', atts)
    expect(parts.some(p => p.type === 'image_url')).toBe(false)
    const note = parts[parts.length - 1]
    expect(note.text).toContain('.attachments/d.csv')
    expect(note.text).toContain('read_file')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd session-agent && npx vitest run src/__tests__/build-user-content.test.js`
Expected: FAIL — `buildUserContent is not a function` / no exportada.

- [ ] **Step 3: Write minimal implementation**

En `session-agent/src/agent.js`, agregar cerca del tope (después de las constantes existentes como `MODEL`):

```js
const VISIBLE_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'])

export function buildUserContent(userMessage, attachments = []) {
  if (!attachments.length) return userMessage
  const parts = []
  if (userMessage) parts.push({ type: 'text', text: userMessage })
  for (const att of attachments) {
    if (VISIBLE_MIME.has(att.mimeType) && att.base64) {
      parts.push({ type: 'image_url', image_url: { url: att.base64 } })
    }
  }
  const list = attachments.map(a => `- ${a.path} (${a.mimeType || 'desconocido'})`).join('\n')
  parts.push({
    type: 'text',
    text: `Archivos adjuntos por el usuario, disponibles en el workspace:\n${list}\n\nLas imágenes y PDFs ya están incluidos arriba para que los veas. Para archivos de datos o texto (csv, json, txt, etc.) usá read_file con la ruta indicada. Estos archivos se commitean al repo cuando hagas git_push.`,
  })
  return parts
}
```

Y cambiar la firma y la construcción de `messages` en `runAgent`:

```js
export async function* runAgent(userMessage, history, systemPrompt, attachments = []) {
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: buildUserContent(userMessage, attachments) },
  ]
```

(el resto de `runAgent` queda igual)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd session-agent && npx vitest run src/__tests__/build-user-content.test.js`
Expected: PASS — 3 tests verdes.

- [ ] **Step 5: Commit**

```bash
git add session-agent/src/agent.js session-agent/src/__tests__/build-user-content.test.js
git commit -m "feat(session-agent): buildUserContent multimodal con adjuntos"
```

---

## Task 3: session-agent — integración en `/chat` (`index.js`)

Recibe `attachments`, los materializa antes de correr el agente, los pasa a `runAgent`, sube el límite de body y documenta los adjuntos en el system prompt.

**Files:**
- Modify: `session-agent/src/index.js`

**Interfaces:**
- Consumes: `writeAttachments` (Task 1), `runAgent(..., attachments)` (Task 2).
- Produces: endpoint `POST /chat` acepta `{ message, history, attachments }`.

- [ ] **Step 1: Subir el límite de body y agregar el import**

En `session-agent/src/index.js`, cambiar la línea del json body:

```js
app.use(express.json({ limit: '30mb' }))
```

Y agregar el import junto a los otros (debajo de `import { runAgent } ...`):

```js
import { writeAttachments } from './attachments.js'
```

- [ ] **Step 2: Materializar adjuntos y pasarlos al agente en `/chat`**

Reemplazar el handler `POST /chat` (bloque `const { message, history = [] } = req.body` … hasta el `for await`) por:

```js
app.post('/chat', async (req, res) => {
  const { message, history = [], attachments = [] } = req.body

  if (!message && (!Array.isArray(attachments) || attachments.length === 0)) {
    return res.status(400).json({ error: 'message o attachments es requerido' })
  }

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

    let written = []
    try {
      written = writeAttachments(attachments)
    } catch (err) {
      console.warn('[session-agent] error materializando adjuntos:', err.message)
    }

    let fullText = ''
    for await (const event of runAgent(message, history, SYSTEM_PROMPT, written)) {
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
```

- [ ] **Step 3: Documentar los adjuntos en `SYSTEM_PROMPT`**

En `session-agent/src/index.js`, dentro del template `SYSTEM_PROMPT`, agregar al final de "REGLAS ADICIONALES" (antes del backtick de cierre):

```
- ADJUNTOS: si el usuario adjunta archivos, están en la carpeta .attachments/ del proyecto. Las imágenes y PDFs ya los ves directamente en el mensaje. Los archivos de datos/texto (csv, json, txt) los leés con read_file usando la ruta .attachments/<nombre>. Todo lo que quede en el workspace (incluida .attachments/) se commitea cuando hacés git_push.
```

- [ ] **Step 4: Verificar que no rompe la suite existente ni la sintaxis**

Run: `cd session-agent && npx vitest run src/__tests__/attachments.test.js src/__tests__/build-user-content.test.js && node --check src/index.js`
Expected: los 2 archivos de tests PASS y `node --check` sin salida (sintaxis OK).

(Nota: `src/__tests__/agent.test.js` está desactualizado —mockea el SDK Anthropic que ya no se usa— y puede fallar independientemente de este cambio; por eso corremos solo los archivos nuevos.)

- [ ] **Step 5: Commit**

```bash
git add session-agent/src/index.js
git commit -m "feat(session-agent): /chat recibe y materializa adjuntos"
```

---

## Task 4: back — reenviar adjuntos al pod y guardar refs en DB

El back recibe `attachments` en `/api/chat/stream`, los guarda como refs `[📎 nombre]` en el mensaje del usuario en DB y los reenvía al pod.

**Files:**
- Create: `back/src/lib/attachments-refs.js`
- Test: `back/src/lib/__tests__/attachments-refs.test.js`
- Modify: `back/package.json` (agregar script `test`)
- Modify: `back/src/routes/proxy.js`

**Interfaces:**
- Consumes: nada.
- Produces: `attachmentsToRefs(attachments = []) => string` — devuelve `''` si no hay adjuntos, o `'\n[📎 name1]\n[📎 name2]'`. `handleWorkspaceStream(req, res, { chatId, messages, projectId, attachments, send, heartbeat })` — nuevo campo `attachments` en el objeto de opciones.

- [ ] **Step 1: Write the failing test**

Crear `back/src/lib/__tests__/attachments-refs.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attachmentsToRefs } from '../attachments-refs.js'

test('devuelve string vacío sin adjuntos', () => {
  assert.equal(attachmentsToRefs([]), '')
  assert.equal(attachmentsToRefs(), '')
})

test('lista refs [📎 nombre] separadas por salto de línea', () => {
  const r = attachmentsToRefs([{ name: 'a.png' }, { name: 'b.csv' }])
  assert.equal(r, '\n[📎 a.png]\n[📎 b.csv]')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd back && node --test src/lib/__tests__/attachments-refs.test.js`
Expected: FAIL — `Cannot find module '../attachments-refs.js'`.

- [ ] **Step 3: Write minimal implementation + script de test**

Crear `back/src/lib/attachments-refs.js`:

```js
// Convierte adjuntos en refs de texto para guardar en el mensaje del usuario en DB.
export function attachmentsToRefs(attachments = []) {
  if (!Array.isArray(attachments) || attachments.length === 0) return ''
  return '\n' + attachments.map(a => `[📎 ${a.name}]`).join('\n')
}
```

En `back/package.json`, agregar al objeto `scripts` (después de `"start": ...`):

```json
    "test": "node --test",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd back && node --test src/lib/__tests__/attachments-refs.test.js`
Expected: PASS — 2 tests verdes.

- [ ] **Step 5: Wire en `proxy.js`**

En `back/src/routes/proxy.js`:

(a) Agregar el import junto a los otros de arriba:

```js
import { attachmentsToRefs } from '../lib/attachments-refs.js'
```

(b) En el handler `POST /stream`, cambiar el destructuring del body para incluir `attachments`:

```js
    const { chatId, model, messages, connectors = [], temperature = 0.7, max_tokens = 8192, projectId, attachments = [] } = req.body
```

(c) En el mismo handler, donde se guarda el mensaje del usuario, sumar las refs:

```js
    const lastUserMsg = messages[messages.length - 1]
    if (lastUserMsg.role === 'user') {
      await prisma.message.create({
        data: { chatId, role: 'user', content: extractTextForDb(lastUserMsg.content) + attachmentsToRefs(attachments) },
      })
    }
```

(d) En la rama de workspace, pasar `attachments` a `handleWorkspaceStream`:

```js
    if (projectId) {
      await handleWorkspaceStream(req, res, { chatId, messages, projectId, attachments, send, heartbeat })
      return
    }
```

(e) Cambiar la firma de `handleWorkspaceStream` para recibir `attachments`:

```js
async function handleWorkspaceStream(req, res, { chatId, messages, projectId, attachments = [], send: rawSend, heartbeat }) {
```

(f) En el `fetch` al pod (`http://${podIP}:3200/chat`), agregar `attachments` al body:

```js
      body: JSON.stringify({
        message: lastUserMsg.content,
        history: messages.slice(0, -1).slice(-6),
        attachments,
      }),
```

- [ ] **Step 6: Verificar sintaxis del back**

Run: `cd back && node --check src/routes/proxy.js && node --test src/lib/__tests__/attachments-refs.test.js`
Expected: `node --check` sin salida y los 2 tests PASS.

- [ ] **Step 7: Commit**

```bash
git add back/src/lib/attachments-refs.js back/src/lib/__tests__/attachments-refs.test.js back/package.json back/src/routes/proxy.js
git commit -m "feat(back): reenviar adjuntos al pod y guardar refs en DB"
```

---

## Task 5: front — UI de adjuntos en el workspace + envío

Agrega botón de adjuntar, preview de chips, validación de límites, render de miniaturas en el historial y envío del campo `attachments`.

**Files:**
- Modify: `front/src/lib/api.js` (parámetro `attachments` en `streamMessage`)
- Modify: `front/src/pages/ProjectWorkspace.jsx`
- Modify: `front/src/pages/ProjectWorkspace.css` (estilos de los adjuntos)

**Interfaces:**
- Consumes: `api.streamMessage(chatId, model, messages, connectors, projectId, attachments)` — nuevo 6º parámetro.
- Produces: feature de UI, sin API para otros módulos.

- [ ] **Step 1: Agregar el parámetro `attachments` a `streamMessage`**

En `front/src/lib/api.js`, reemplazar `streamMessage` por:

```js
  streamMessage: (chatId, model, messages, connectors = [], projectId, attachments = []) => {
    const token = getToken()
    return fetch(`${API_URL}/api/chat/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        chatId, model, messages, connectors,
        ...(projectId ? { projectId } : {}),
        ...(attachments.length ? { attachments } : {}),
      }),
    })
  },
```

- [ ] **Step 2: Imports, estado y constantes en `ProjectWorkspace.jsx`**

(a) En el import de `lucide-react` (líneas 3-7), agregar `Paperclip` y `FileText`:

```js
import {
  ArrowLeft, ExternalLink, GitBranch, Pencil, Check, X,
  Send, Bot, User, Copy, CheckCheck, Loader2,
  Globe, EyeOff, Zap, Paperclip, FileText,
} from 'lucide-react'
```

(b) Debajo de `const CONNECTORS = ['workspaceSandbox']` (línea 38), agregar las constantes de límites:

```js
const MAX_FILES = 5
const MAX_FILE_BYTES = 10 * 1024 * 1024
const MAX_TOTAL_BYTES = 20 * 1024 * 1024
const ATTACH_ACCEPT = 'image/*,audio/*,video/*,.pdf,.txt,.csv,.json,.md,.py,.js,.ts,.jsx,.tsx,.html,.css'
```

(c) Junto a los otros `useState` del componente (cerca de `const [input, setInput] = useState('')`), agregar:

```js
  const [attachments, setAttachments] = useState([])
  const [attachError, setAttachError] = useState('')
  const fileInputRef = useRef(null)
```

- [ ] **Step 3: Handlers `handleFileSelect` y `removeAttachment`**

Agregar dentro del componente, cerca de `doSend` (antes de `handleKeyDown`):

```js
  const handleFileSelect = (e) => {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    if (!files.length) return
    setAttachError('')

    const tooBig = files.filter(f => f.size > MAX_FILE_BYTES)
    if (tooBig.length) {
      setAttachError(`Cada archivo debe pesar menos de 10 MB: ${tooBig.map(f => f.name).join(', ')}`)
      return
    }
    if (attachments.length + files.length > MAX_FILES) {
      setAttachError(`Máximo ${MAX_FILES} archivos por mensaje.`)
      return
    }
    const currentBytes = attachments.reduce((s, a) => s + (a.size || 0), 0)
    const newBytes = files.reduce((s, f) => s + f.size, 0)
    if (currentBytes + newBytes > MAX_TOTAL_BYTES) {
      setAttachError('El total de adjuntos supera los 20 MB.')
      return
    }

    files.forEach(file => {
      const isImage = file.type.startsWith('image/')
      const isText = /^text\/|json|javascript|typescript|css|html|xml|csv|markdown|yaml/.test(file.type)
        || /\.(txt|md|py|js|ts|jsx|tsx|css|html|json|csv|yaml|yml|sh|sql|env)$/i.test(file.name)
      const reader = new FileReader()
      if (isText) {
        reader.onload = () => setAttachments(prev => [...prev, {
          name: file.name, type: file.type, size: file.size, textContent: reader.result, isImage: false,
        }])
        reader.readAsText(file)
      } else {
        reader.onload = () => setAttachments(prev => [...prev, {
          name: file.name, type: file.type, size: file.size, base64: reader.result, isImage,
        }])
        reader.readAsDataURL(file)
      }
    })
  }

  const removeAttachment = (idx) => setAttachments(prev => prev.filter((_, i) => i !== idx))
```

- [ ] **Step 4: Actualizar `doSend` para enviar adjuntos**

Reemplazar el cuerpo de `doSend` (líneas 444-478) por:

```js
  const doSend = async (overrideInput) => {
    const text = (overrideInput ?? input).trim()
    const atts = overrideInput ? [] : attachments
    if ((!text && !atts.length) || !chat) return

    setSending(true)
    setActivitySync(emptyActivity())
    setPipelineState(null)

    const userMsg = { role: 'user', content: text, attachments: atts }
    const newMessages = [...messages, userMsg]
    setMessages(newMessages)
    if (!overrideInput) { setInput(''); setAttachments([]); setAttachError('') }

    try {
      const systemMsg = { role: 'system', content: buildSystemPrompt() }
      const apiMessages = [
        systemMsg,
        ...newMessages
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .map(m => ({ role: m.role, content: m.content })),
      ]

      const payload = atts.map(a => ({
        name: a.name, type: a.type, base64: a.base64, textContent: a.textContent,
      }))

      const response = await api.streamMessage(chat.id, selectedModel, apiMessages, CONNECTORS, project.id, payload)
      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: 'Error del servidor' }))
        throw new Error(err.error || 'Error del servidor')
      }
      await consumeSSE(response)
    } catch (err) {
      setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${err.message}` }])
      setActivitySync(emptyActivity())
    } finally {
      setSending(false)
    }
  }
```

- [ ] **Step 5: Render de miniaturas en el mensaje del usuario**

En el `messages.map` (dentro del `<div className="pw-msg-body">`, línea ~678), agregar antes del bloque que renderiza el contenido:

```jsx
                <div className="pw-msg-body">
                  {msg.role === 'user' && msg.attachments?.length > 0 && (
                    <div className="pw-msg-attachments">
                      {msg.attachments.map((a, j) => (
                        a.isImage
                          ? <img key={j} src={a.base64} alt={a.name} className="pw-attach-thumb" />
                          : <span key={j} className="pw-attach-file"><FileText size={12} /> {a.name}</span>
                      ))}
                    </div>
                  )}
                  {msg.role === 'assistant' ? (
```

(el resto del `pw-msg-body` queda igual)

- [ ] **Step 6: Botón de adjuntar + preview en el área de input**

Reemplazar el bloque del área de input (desde `<div className="pw-input-area">` en la línea 713 hasta el `<textarea>`) para insertar el error, el preview y el botón. El resultado debe quedar así:

```jsx
          <div className="pw-input-area">
            {attachError && <div className="pw-attach-error">{attachError}</div>}
            {attachments.length > 0 && (
              <div className="pw-attachments-preview">
                {attachments.map((file, i) => (
                  <div key={i} className="pw-attachment-chip">
                    {file.isImage
                      ? <img src={file.base64} alt={file.name} className="pw-attachment-thumb" />
                      : <FileText size={14} />}
                    <span className="pw-attachment-name">{file.name}</span>
                    <button className="pw-attachment-remove" onClick={() => removeAttachment(i)}>
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <span className="pw-model-badge">
              <img src="https://www.google.com/s2/favicons?sz=64&domain=claude.ai" alt="Claude" />
              Claude Sonnet
            </span>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ATTACH_ACCEPT}
              onChange={handleFileSelect}
              style={{ display: 'none' }}
            />
            <button
              className="pw-attach-btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={sending}
              title="Adjuntar archivo"
            >
              <Paperclip size={16} />
            </button>
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                pipelineState?.status === 'running'
                  ? '🔒 Tu app se está publicando, el chat se activa cuando esté lista...'
                  : 'Pedile a la IA que cree archivos, modifique código, buildee...'
              }
              rows={1}
              disabled={sending}
            />
            <button
              className="pw-send-btn"
              onClick={() => doSend()}
              disabled={(!input.trim() && !attachments.length) || sending}
            >
              <Send size={16} />
            </button>
          </div>
```

- [ ] **Step 7: Estilos en `ProjectWorkspace.css`**

Agregar al final de `front/src/pages/ProjectWorkspace.css`:

```css
/* Adjuntos del chat */
.pw-attach-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  color: #8a8f98;
  cursor: pointer;
  padding: 6px;
  border-radius: 6px;
}
.pw-attach-btn:hover:not(:disabled) { color: #e4e6eb; background: rgba(255,255,255,0.06); }
.pw-attach-btn:disabled { opacity: 0.4; cursor: default; }

.pw-attach-error {
  color: #ff6b6b;
  font-size: 12px;
  margin-bottom: 6px;
}

.pw-attachments-preview {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}
.pw-attachment-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  background: rgba(255,255,255,0.06);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 8px;
  padding: 4px 8px;
  font-size: 12px;
  color: #e4e6eb;
  max-width: 200px;
}
.pw-attachment-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pw-attachment-thumb { width: 24px; height: 24px; object-fit: cover; border-radius: 4px; }
.pw-attachment-remove {
  display: flex; align-items: center; background: transparent; border: none;
  color: #8a8f98; cursor: pointer; padding: 0;
}
.pw-attachment-remove:hover { color: #ff6b6b; }

.pw-msg-attachments { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
.pw-attach-thumb { max-width: 160px; max-height: 120px; border-radius: 8px; object-fit: cover; }
.pw-attach-file {
  display: inline-flex; align-items: center; gap: 4px;
  background: rgba(255,255,255,0.06); border-radius: 6px; padding: 3px 8px; font-size: 12px;
}
```

(Nota: si los tokens de color del CSS existente difieren, ajustar para que matcheen el resto del archivo; estos son de fallback sobre fondo oscuro.)

- [ ] **Step 8: Verificar que el front compila**

Run: `cd front && npm run build`
Expected: build exitoso sin errores de sintaxis ni imports faltantes.

- [ ] **Step 9: Verificación manual (smoke test)**

Levantar el front/back de dev y en un workspace de proyecto:
1. Adjuntar una imagen (PNG) → aparece la miniatura como chip; enviar un pedido "replicá este diseño" → el agente responde teniendo en cuenta la imagen.
2. Adjuntar un CSV → el agente lo lee con `read_file` (se ve el `tool_start: read_file .attachments/...` en la actividad).
3. Verificar que tras `git_push` los archivos quedan en `.attachments/` del repo en GitLab.
4. Intentar adjuntar 6 archivos o uno > 10 MB → aparece el mensaje de error y no se agregan.

- [ ] **Step 10: Commit**

```bash
git add front/src/lib/api.js front/src/pages/ProjectWorkspace.jsx front/src/pages/ProjectWorkspace.css
git commit -m "feat(front): adjuntar archivos en el chat de Proyectos"
```

---

## Notas de deploy

- **session-agent** corre como imagen en pods CCE (`swr.la-south-2.myhuaweicloud.com/sandbox-allaria/session-agent:latest`). Los cambios de Tasks 1-3 requieren rebuildear y pushear esa imagen para que los pods nuevos la tomen (los pods se crean por sesión). Ver el flujo de build de imágenes del proyecto.
- **back** y **front** deployan por el flujo normal del Hub (GitLab CI a CCE, ver `reference_deploy_hub_cce`).
- No hay cambios de schema Prisma ni migraciones.
