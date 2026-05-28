import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  ArrowLeft, ExternalLink, GitBranch, Pencil, Check, X,
  Send, Bot, User, Copy, CheckCheck, Loader2,
  Globe, EyeOff, Zap,
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import { api } from '../lib/api'
import { useAuth } from '../context/AuthContext'
import './ProjectWorkspace.css'

const SANDBOX_SYSTEM_PROMPT = `Sos el asistente de desarrollo de este proyecto web.

REGLA FUNDAMENTAL — SIN EXCEPCIONES:
Nunca digas "listo", "hecho" ni des por completada ninguna tarea sin haber ejecutado el flujo completo.

FLUJO OBLIGATORIO para cualquier modificación:
1. read_file — Leé el archivo actual antes de modificar
2. write_file — Escribí el archivo completo con los cambios aplicados
3. git_push — Commitea y pushea los cambios. El CI de GitLab buildea y deploya automáticamente.
4. Confirmá al usuario: "✅ Pusheado. El CI está desplegando (~5min). Podés verlo en la preview."

HERRAMIENTAS DISPONIBLES:
- read_file(path) — leer un archivo del proyecto
- write_file(path, content) — escribir un archivo completo
- list_files() — ver estructura del proyecto
- bash(cmd) — ejecutar npm install, npm run, etc.
- git_push(message) — commitear y pushear todos los cambios

REGLAS ADICIONALES:
- Para instalar librerías: bash("npm install <paquete>") → write_file → git_push
- Si el usuario pregunta "¿en qué estábamos?", leé CHANGELOG.md primero con read_file
- Actualizá CHANGELOG.md con fecha y descripción de cada cambio
- NO creés proyectos nuevos desde acá`

const DEFAULT_MODEL = 'claude-sonnet-4-5'
const CONNECTORS = ['workspaceSandbox']

const PIPELINE_STAGES = [
  { id: 'build',  emoji: '📦', label: 'Empaquetando tu app',  durationKey: 'build' },
  { id: 'deploy', emoji: '🚀', label: 'Lanzando al servidor', durationKey: 'deploy' },
  { id: 'live',   emoji: '🎉', label: '¡Tu app lista!',       durationKey: null },
]

const TOOL_PROGRESS = {
  write_file:    (a) => `Escribiendo ${a.path || 'archivo'}`,
  read_file:     (a) => `Leyendo ${a.path || 'archivo'}`,
  list_files:    ()  => 'Listando archivos',
  bash:          (a) => `$ ${a.cmd || ''}`,
  git_push:      (a) => `Pusheando: ${a.message || ''}`,
  sandbox_write_file: (a) => `Escribiendo ${a.filePath || 'archivo'}`,
  sandbox_read_file:  (a) => `Leyendo ${a.filePath || 'archivo'}`,
  sandbox_list_files: ()  => 'Listando archivos',
  sandbox_build:      ()  => 'Pusheando y esperando pipeline CI...',
  sandbox_status:     ()  => 'Revisando estado',
}

const STATUS_COLORS = { running: '#22c55e', stopped: '#888', creating: '#eab308', error: '#ef4444' }
const STATUS_LABELS = { running: 'Activo', stopped: 'Detenido', creating: 'Creando...', error: 'Error' }

const emptyActivity = () => ({ events: [], status: 'idle' })

export default function ProjectWorkspace() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()

  const [project, setProject]   = useState(null)
  const [chat, setChat]         = useState(null)
  const [messages, setMessages] = useState([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState('')

  const [editingTitle, setEditingTitle] = useState(false)
  const [editingDesc, setEditingDesc]   = useState(false)
  const [titleDraft, setTitleDraft]     = useState('')
  const [descDraft, setDescDraft]       = useState('')
  const [savingTitle, setSavingTitle]   = useState(false)
  const [savingDesc, setSavingDesc]     = useState(false)
  const [titleError, setTitleError]     = useState('')
  const [descError, setDescError]       = useState('')
  const [descSaved, setDescSaved]       = useState(false)

  const [input, setInput]               = useState('')
  const [selectedModel] = useState(DEFAULT_MODEL)
  const [sending, setSending]           = useState(false)
  const [activity, setActivity]         = useState(emptyActivity())
  const [workspaceStatus, setWorkspaceStatus] = useState('unknown') // unknown|starting|ready|none
  const [copied, setCopied]             = useState(null)
  const [pipelineState, setPipelineState] = useState(null)
  // null = sin pipeline activo/reciente
  // { status: 'running'|'success'|'error', stages: [{id, status}], duration: {}, failedJob: null|string }

  const messagesEndRef = useRef(null)
  const inputRef       = useRef(null)
  const activeStreamRef = useRef(null) // AbortController de la conexión actual
  // Ref paralelo al state `activity` para poder leerlo sincrono en handlers SSE
  // (el state de React puede estar stale dentro de updaters async)
  const activityRef = useRef(emptyActivity())

  const setActivitySync = useCallback((next) => {
    const value = typeof next === 'function' ? next(activityRef.current) : next
    activityRef.current = value
    setActivity(value)
  }, [])

  // ─────────────────────────────────────────────────────────────────────────
  // CARGA INICIAL
  // ─────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    async function load() {
      try {
        const [proj, chatData] = await Promise.all([
          api.getProject(id),
          api.getProjectChat(id),
        ])
        setProject(proj)
        setChat(chatData)
        const msgs = chatData.messages || []
        setMessages(msgs)
        setTitleDraft(proj.title)
        setDescDraft(proj.description || '')
      } catch (err) {
        setError(err.message)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [id])

  // Auto-refresh: si el proyecto está creando, esperar a que esté running
  useEffect(() => {
    if (project?.status !== 'creating') return
    const interval = setInterval(async () => {
      try {
        const updated = await api.getProject(id)
        if (updated.status !== 'creating') setProject(updated)
      } catch {}
    }, 5000)
    return () => clearInterval(interval)
  }, [project?.status, id])

  // Arrancar pod de sesión cuando el proyecto cargue.
  // No matamos el pod al desmontar: el session-agent ya tiene idle timeout
  // de 60min y el reconcile del back limpia sesiones >70min. Así, salir
  // del workspace y volver reusa el mismo pod sin esperar cold start.
  useEffect(() => {
    if (!project?.id || project.status === 'creating') return
    setWorkspaceStatus('starting')
    api.startSession(project.id).then(r => {
      if (r?.status === 'ready') setWorkspaceStatus('ready')
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id])

  // Polling del estado de la sesión mientras está "starting"
  useEffect(() => {
    if (!project?.id || workspaceStatus === 'ready') return
    let cancelled = false
    const tick = async () => {
      const s = await api.getSession(project.id)
      if (cancelled) return
      if (s?.status === 'ready') setWorkspaceStatus('ready')
      else if (s?.status === 'starting') setWorkspaceStatus('starting')
      else if (s?.status === 'none') setWorkspaceStatus('none')
    }
    tick()
    const interval = setInterval(tick, 4000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [project?.id, workspaceStatus])

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, sending, activity])

  // ─────────────────────────────────────────────────────────────────────────
  // EVENT HANDLER — usado tanto por doSend() como por reconnectToActiveStream()
  // ─────────────────────────────────────────────────────────────────────────
  const handleStreamEvent = useCallback((event) => {
    if (event.type === 'workspace_starting') {
      setWorkspaceStatus('starting')
      return
    }
    if (event.type === 'workspace_ready') {
      setWorkspaceStatus('ready')
      return
    }
    if (event.type === 'thinking') {
      // ignorado: la UI ya muestra la tarjeta de actividad
      return
    }
    if (event.type === 'text') {
      setActivitySync(prev => {
        const events = [...prev.events]
        const last = events[events.length - 1]
        if (last && last.type === 'text') {
          events[events.length - 1] = { ...last, content: last.content + event.content }
        } else {
          events.push({
            id: `text-${Date.now()}-${Math.random()}`,
            type: 'text',
            content: event.content,
          })
        }
        return { events, status: 'running' }
      })
      return
    }
    if (event.type === 'tool_start') {
      const label = TOOL_PROGRESS[event.name]?.(event.args || {}) ?? event.name
      setActivitySync(prev => ({
        status: 'running',
        events: [...prev.events, {
          id: `tool-${Date.now()}-${Math.random()}`,
          type: 'tool',
          name: event.name,
          label,
          status: 'running',
        }],
      }))
      return
    }
    if (event.type === 'tool_done') {
      setActivitySync(prev => {
        const events = [...prev.events]
        for (let i = events.length - 1; i >= 0; i--) {
          if (events[i].type === 'tool' && events[i].status === 'running') {
            events[i] = { ...events[i], status: 'done' }
            break
          }
        }
        return { ...prev, events }
      })
      return
    }
    if (event.type === 'pushed') {
      setPipelineState({
        status: 'running',
        stages: PIPELINE_STAGES.map(s => ({ id: s.id, status: 'pending' })),
        duration: {},
        failedJob: null,
      })
      return
    }
    if (event.type === 'pipeline_stage') {
      setPipelineState(prev => {
        if (!prev) return prev
        const statusMap = { running: 'running', success: 'done', failed: 'failed' }
        return {
          ...prev,
          stages: prev.stages.map(s =>
            s.id === event.job ? { ...s, status: statusMap[event.status] ?? event.status } : s
          ),
        }
      })
      return
    }

    if (event.type === 'pipeline_done') {
      setPipelineState(prev => prev ? {
        ...prev,
        status: 'success',
        stages: prev.stages.map(s => ({ ...s, status: 'done' })),
        duration: event.duration || {},
      } : prev)
      return
    }

    if (event.type === 'pipeline_error') {
      setPipelineState(prev => {
        if (!prev) return prev
        return {
          ...prev,
          status: 'error',
          failedJob: event.failedJob || null,
          errorMessage: event.message || null,
          stages: prev.stages.map(s =>
            s.id === event.failedJob ? { ...s, status: 'failed' } : s
          ),
        }
      })
      return
    }

    if (event.type === 'done') {
      // Leer events sincrono del ref (state puede estar stale en handlers async).
      // Veredicto = último bloque de texto. Si está vacío, fallback al fullText
      // del back. Si todo está vacío, mensaje placeholder para que el usuario
      // sepa que el bot respondió.
      const currentEvents = activityRef.current.events
      const textBlocks = currentEvents.filter(e => e.type === 'text')
      let summary = textBlocks.length > 0 ? (textBlocks[textBlocks.length - 1].content || '') : ''
      if (!summary.trim()) summary = event.content || ''
      if (!summary.trim()) summary = '(Sin contenido en la respuesta)'
      setMessages(prev => [...prev, { role: 'assistant', content: summary }])
      setActivitySync(emptyActivity())
      return
    }
    if (event.type === 'error') {
      setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${event.message}` }])
      setActivitySync(emptyActivity())
    }
  }, [setActivitySync])

  // Lee SSE de un Response y dispara handleStreamEvent por cada evento
  const consumeSSE = useCallback(async (response, { onEnd } = {}) => {
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let ended = false
    try {
      while (!ended) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const parts = buffer.split('\n\n')
        buffer = parts.pop()
        for (const part of parts) {
          if (!part.startsWith('data: ')) continue
          let event
          try { event = JSON.parse(part.slice(6)) } catch { continue }
          if (event.type === '_stream_ended' || event.type === 'no_active_stream') {
            ended = true
            onEnd?.(event)
            break
          }
          handleStreamEvent(event)
          if (event.type === 'error') ended = true
          // No romper en 'done': el backend puede seguir enviando pipeline_stage/done/error
          // hasta que mande _stream_ended, que cierra el stream definitivamente.
        }
      }
    } catch {}
  }, [handleStreamEvent])

  // ─────────────────────────────────────────────────────────────────────────
  // RECONEXIÓN: al montar, si el último mensaje es del usuario, intentar
  // engancharse al stream activo del back
  // ─────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!project?.id || !chat?.id) return
    if (messages.length === 0) return
    if (messages[messages.length - 1].role !== 'user') return
    if (sending) return

    let aborted = false
    const ctrl = new AbortController()
    activeStreamRef.current = ctrl

    setSending(true)
    ;(async () => {
      try {
        const res = await api.openActiveStream(project.id)
        if (aborted || !res.ok) {
          setSending(false)
          return
        }
        let hadActiveStream = true
        await consumeSSE(res, {
          onEnd: (event) => {
            if (event.type === 'no_active_stream') hadActiveStream = false
          },
        })
        if (!aborted) {
          setSending(false)
          // Si no había stream activo, traer el mensaje final si quedó guardado
          if (!hadActiveStream) {
            try {
              const chatData = await api.getProjectChat(id)
              const msgs = chatData.messages || []
              if (msgs.length > messages.length) setMessages(msgs)
            } catch {}
          }
        }
      } catch {
        if (!aborted) setSending(false)
      }
    })()

    return () => {
      aborted = true
      ctrl.abort()
    }
    // Solo correr una vez tras carga inicial
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, chat?.id])

  // ─────────────────────────────────────────────────────────────────────────
  // ACCIONES DE EDICIÓN (igual que antes)
  // ─────────────────────────────────────────────────────────────────────────
  const saveTitle = async () => {
    if (!titleDraft.trim()) return
    setSavingTitle(true)
    setTitleError('')
    try {
      const updated = await api.updateProject(id, { title: titleDraft.trim() })
      setProject(updated)
      setEditingTitle(false)
    } catch (err) {
      setTitleError(err.message || 'Error al guardar')
    } finally {
      setSavingTitle(false)
    }
  }

  const saveDesc = async () => {
    setSavingDesc(true)
    setDescError('')
    try {
      const updated = await api.updateProject(id, { description: descDraft })
      setProject(updated)
      setEditingDesc(false)
      setDescSaved(true)
      setTimeout(() => setDescSaved(false), 2000)
    } catch (err) {
      setDescError(err.message || 'Error al guardar')
    } finally {
      setSavingDesc(false)
    }
  }

  const handlePublishToggle = async () => {
    try {
      const updated = project.isPublic
        ? await api.unpublishProject(id)
        : await api.publishProject(id)
      setProject(prev => ({ ...prev, ...updated }))
    } catch (err) {
      alert('Error: ' + err.message)
    }
  }

  const buildSystemPrompt = () => {
    const projectName = project?.name || ''
    return `${SANDBOX_SYSTEM_PROMPT} El proyecto activo es "${projectName}". Cuando uses las tools de sandbox, el projectName es siempre "${projectName}".`
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ENVIAR MENSAJE
  // ─────────────────────────────────────────────────────────────────────────
  const doSend = async (overrideInput) => {
    const text = (overrideInput ?? input).trim()
    if (!text || !chat) return

    setSending(true)
    setActivitySync(emptyActivity())
    setPipelineState(null)

    const userMsg = { role: 'user', content: text }
    const newMessages = [...messages, userMsg]
    setMessages(newMessages)
    if (!overrideInput) setInput('')

    try {
      const systemMsg = { role: 'system', content: buildSystemPrompt() }
      const apiMessages = [
        systemMsg,
        ...newMessages
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .map(m => ({ role: m.role, content: m.content })),
      ]

      const response = await api.streamMessage(chat.id, selectedModel, apiMessages, CONNECTORS, project.id)
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

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      doSend()
    }
  }

  const copyMsg = (text, idx) => {
    navigator.clipboard.writeText(text)
    setCopied(idx)
    setTimeout(() => setCopied(null), 2000)
  }

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER GATES
  // ─────────────────────────────────────────────────────────────────────────
  if (loading) return (
    <div className="pw-loading"><Loader2 size={24} className="pw-spin" /></div>
  )

  if (error) return (
    <div className="pw-error">
      <p>{error}</p>
      <button className="btn btn-primary" onClick={() => navigate('/proyectos')}>Volver</button>
    </div>
  )

  // Pantalla "El proyecto se está creando" SOLO si el chat está vacío.
  // Si ya hay mensajes, es un re-deploy en curso — el usuario sigue en el
  // workspace y se muestra un banner inline (más abajo).
  if (project?.status === 'creating' && messages.length === 0) return (
    <div className="pw-error">
      <Loader2 size={32} className="pw-spin" style={{ color: '#eab308' }} />
      <p style={{ marginTop: '1rem', fontWeight: 600 }}>El proyecto se está creando...</p>
      <p style={{ fontSize: '13px', color: 'var(--text-tertiary)' }}>Esto puede tardar hasta un minuto. El workspace abre automáticamente cuando esté listo.</p>
      <button className="btn btn-primary" style={{ marginTop: '1rem' }} onClick={() => navigate('/proyectos')}>Volver al hub</button>
    </div>
  )

  if (project?.status === 'error') return (
    <div className="pw-error">
      <p style={{ fontSize: '2rem' }}>⚠️</p>
      <p style={{ fontWeight: 600 }}>El proyecto tuvo un error al crearse</p>
      <p style={{ fontSize: '13px', color: 'var(--text-tertiary)' }}>El container no pudo buildear correctamente.</p>
      <button className="btn btn-primary" style={{ marginTop: '1rem' }} onClick={() => navigate('/proyectos')}>Volver al hub</button>
    </div>
  )

  const hasActivity = activity.events.length > 0
  const showStartingBanner = workspaceStatus === 'starting'

  return (
    <div className="pw-root">
      {/* TOP BAR */}
      <div className="pw-topbar">
        <button className="pw-back" onClick={() => navigate('/proyectos')}>
          <ArrowLeft size={16} /> Proyectos
        </button>
        <div className="pw-topbar-title">
          {editingTitle ? (
            <div className="pw-inline-edit">
              <input
                value={titleDraft}
                onChange={e => { setTitleDraft(e.target.value); setTitleError('') }}
                onKeyDown={e => { if (e.key === 'Enter') saveTitle(); if (e.key === 'Escape') { setEditingTitle(false); setTitleError('') } }}
                autoFocus
              />
              <button onClick={saveTitle} disabled={savingTitle}>
                {savingTitle ? <Loader2 size={14} className="spin-icon" /> : <Check size={14} />}
              </button>
              <button onClick={() => { setEditingTitle(false); setTitleError('') }}><X size={14} /></button>
              {titleError && <span className="pw-title-error">{titleError}</span>}
            </div>
          ) : (
            <span className="pw-title-text" onClick={() => setEditingTitle(true)}>
              {project.title} <Pencil size={12} className="pw-edit-icon" />
            </span>
          )}
        </div>
        <div className="pw-topbar-actions">
          <span className="pw-status-badge" style={{ '--sc': STATUS_COLORS[project.status] || '#888' }}>
            {STATUS_LABELS[project.status] || project.status}
          </span>
          {project.previewUrl && (
            <a href={project.previewUrl} target="_blank" rel="noopener noreferrer" className="pw-action-btn">
              <ExternalLink size={14} /> Preview
            </a>
          )}
          {project.repoUrl && (
            <a href={project.repoUrl} target="_blank" rel="noopener noreferrer" className="pw-action-btn">
              <GitBranch size={14} /> GitLab
            </a>
          )}
        </div>
      </div>

      {/* MAIN LAYOUT */}
      <div className="pw-body">
        {/* SIDEBAR */}
        <aside className="pw-sidebar">
          <div className="pw-sidebar-section">
            <h4>Descripción</h4>
            {editingDesc ? (
              <div className="pw-desc-edit">
                <textarea value={descDraft} onChange={e => setDescDraft(e.target.value)} rows={4} autoFocus
                  onKeyDown={e => { if (e.key === 'Escape') { setEditingDesc(false); setDescError('') } }}
                />
                {descError && <p className="pw-save-error">{descError}</p>}
                <div className="pw-desc-edit-actions">
                  <button className="btn-sm" onClick={saveDesc} disabled={savingDesc}>
                    {savingDesc ? <Loader2 size={12} className="spin-icon" /> : <Check size={12} />}
                    {savingDesc ? 'Guardando...' : 'Guardar'}
                  </button>
                  <button className="btn-sm ghost" onClick={() => { setEditingDesc(false); setDescError('') }}>Cancelar</button>
                </div>
              </div>
            ) : (
              <p className="pw-desc-text" onClick={() => { setEditingDesc(true); setDescSaved(false) }}>
                {descSaved
                  ? <span className="pw-saved-badge"><Check size={11} /> Guardado</span>
                  : (project.description || <span className="pw-desc-empty">+ Agregar descripción</span>)
                }
                {!descSaved && <Pencil size={11} className="pw-edit-icon" />}
              </p>
            )}
          </div>

          <div className="pw-sidebar-section">
            <h4>Visibilidad</h4>
            {project.status === 'running' ? (
              <button
                className={`pw-visibility-btn${project.isPublic ? ' pw-visibility-btn--public' : ''}`}
                onClick={handlePublishToggle}
              >
                {project.isPublic
                  ? <><EyeOff size={13} /> Despublicar</>
                  : <><Globe size={13} /> Publicar en el Hub</>
                }
              </button>
            ) : (
              <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>
                Solo se pueden publicar proyectos activos
              </span>
            )}
            {project.isPublic && (
              <p style={{ fontSize: '11px', color: '#22c55e', marginTop: '6px' }}>
                Visible en el Hub de comunidad
              </p>
            )}
          </div>

          <div className="pw-sidebar-section">
            <h4>Detalles</h4>
            <div className="pw-detail-row"><span>Slug</span><code>{project.name}</code></div>
            <div className="pw-detail-row"><span>Template</span><code>{project.template}</code></div>
            {project.port && <div className="pw-detail-row"><span>Puerto</span><code>{project.port}</code></div>}
            <div className="pw-detail-row">
              <span>Creado</span>
              <span>{new Date(project.createdAt).toLocaleDateString('es-AR')}</span>
            </div>
          </div>

          {project.previewUrl && (
            <div className="pw-sidebar-section">
              <h4>Preview URL</h4>
              <a href={project.previewUrl} target="_blank" rel="noopener noreferrer" className="pw-preview-link">
                {project.previewUrl} <ExternalLink size={11} />
              </a>
            </div>
          )}
        </aside>

        {/* CHAT */}
        <div className="pw-chat">
          {/* Banner persistente cuando el workspace está arrancando */}
          {showStartingBanner && (
            <div className="pw-workspace-banner">
              <Loader2 size={14} className="pw-spin" />
              <div className="pw-workspace-banner-content">
                <strong>Iniciando espacio de trabajo</strong>
                <span>Estoy levantando tu entorno de desarrollo. Puede tardar hasta 2 minutos la primera vez.</span>
              </div>
            </div>
          )}

          <div className="pw-messages">
            {messages.length === 0 && !sending && (
              <div className="pw-welcome">
                <Bot size={32} />
                <p>Hola, soy tu asistente para este proyecto. Puedo crear y modificar archivos, buildear la preview y pushear a GitLab. ¿En qué empezamos?</p>
              </div>
            )}

            {messages.map((msg, i) => (
              <div key={i} className={`pw-msg pw-msg-${msg.role}`}>
                <div className="pw-msg-avatar">
                  {msg.role === 'user' ? <User size={14} /> : <Bot size={14} />}
                </div>
                <div className="pw-msg-body">
                  {msg.role === 'assistant' ? (
                    <ReactMarkdown>{msg.content}</ReactMarkdown>
                  ) : (
                    <p>{typeof msg.content === 'string' ? msg.content : ''}</p>
                  )}
                  {msg.role === 'assistant' && (
                    <button className="pw-copy-btn" onClick={() => copyMsg(msg.content, i)}>
                      {copied === i ? <CheckCheck size={12} /> : <Copy size={12} />}
                    </button>
                  )}
                </div>
              </div>
            ))}

            {/* TARJETA DE ACTIVIDAD EN VIVO */}
            {(hasActivity || (sending && !hasActivity)) && (
              <ActivityCard activity={activity} sending={sending} workspaceStatus={workspaceStatus} />
            )}

            {pipelineState && (
              <PipelineTracker
                pipelineState={pipelineState}
                previewUrl={project?.previewUrl}
                onRetry={() => {
                  const failedLabel = PIPELINE_STAGES.find(s => s.id === pipelineState?.failedJob)?.label || pipelineState?.failedJob || 'desconocida'
                  const errMsg = pipelineState?.errorMessage ? ` El error fue: "${pipelineState.errorMessage}".` : ''
                  doSend(`El pipeline de CI/CD falló en la etapa "${failedLabel}".${errMsg} Por favor intentá hacer el push y deploy de nuevo.`)
                }}
              />
            )}

            <div ref={messagesEndRef} />
          </div>

          <div className="pw-input-area">
            <span className="pw-model-badge">
              <img src="https://www.google.com/s2/favicons?sz=64&domain=claude.ai" alt="Claude" />
              Claude Sonnet
            </span>
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
              disabled={!input.trim() || sending}
            >
              <Send size={16} />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Tarjeta de actividad en vivo: texto del bot + tools intercaladas
// ─────────────────────────────────────────────────────────────────────────────
function ActivityCard({ activity, sending, workspaceStatus }) {
  const empty = activity.events.length === 0
  const initialLabel = workspaceStatus === 'starting'
    ? 'Esperando que arranque el espacio de trabajo...'
    : 'Pensando...'

  return (
    <div className="pw-activity">
      <div className="pw-activity-header">
        <span className="pw-activity-pulse" />
        <span>{empty ? initialLabel : 'Trabajando en tu pedido...'}</span>
      </div>

      {activity.events.map(ev => {
        if (ev.type === 'text') {
          return (
            <div key={ev.id} className="pw-activity-text">
              <ReactMarkdown>{ev.content}</ReactMarkdown>
            </div>
          )
        }
        if (ev.type === 'tool') {
          return (
            <div key={ev.id} className={`pw-activity-tool pw-activity-tool--${ev.status}`}>
              {ev.status === 'running'
                ? <Loader2 size={12} className="pw-spin" />
                : <Check size={12} />
              }
              <span>{ev.label}</span>
            </div>
          )
        }
        if (ev.type === 'info') {
          return (
            <div key={ev.id} className="pw-activity-info">
              <Zap size={12} />
              <span>{ev.label}</span>
            </div>
          )
        }
        return null
      })}

      {empty && sending && (
        <div className="pw-activity-typing"><span /><span /><span /></div>
      )}
    </div>
  )
}

function PipelineTracker({ pipelineState, previewUrl, onRetry }) {
  const { status, stages, duration, failedJob } = pipelineState

  const header = {
    running: 'Tu cambio está viajando…',
    success: '¡Cambio publicado!',
    error: 'Algo salió mal',
  }[status]

  const hint = {
    running: '🔒 El chat se activa cuando tu app esté lista',
    success: '✅ ¡Listo! Podés seguir haciendo cambios',
    error: '⚠️ Chat desbloqueado — podés pedirme que reintente',
  }[status]

  return (
    <div className={`pw-pipeline pw-pipeline--${status}`}>
      <div className="pw-pipeline-header">
        <span className={`pw-pipeline-dot pw-pipeline-dot--${status}`} />
        <span>{header}</span>
      </div>

      {status === 'success' && (
        <div className="pw-pipeline-celebration">
          <span className="pw-pipeline-glow">🎉</span>
          <div>
            <div className="pw-pipeline-celebration-title">¡Tu app está en vivo!</div>
            <div className="pw-pipeline-celebration-sub">Los cambios ya son visibles para todos</div>
          </div>
        </div>
      )}

      {PIPELINE_STAGES.map(def => {
        const stage = stages.find(s => s.id === def.id) || { id: def.id, status: 'pending' }
        const dur = def.durationKey ? duration[def.durationKey] : null

        const sub = {
          pending: 'Pronto…',
          running: 'En camino…',
          done: dur || 'Completado',
          failed: 'No pudo completarse',
        }[stage.status] ?? ''

        return (
          <div key={def.id} className={`pw-pipeline-step pw-pipeline-step--${stage.status}`}>
            <div className={`pw-pipeline-icon${stage.status === 'running' ? ' pw-pipeline-icon--anim' : ''}`}>
              {def.emoji}
            </div>
            <div className="pw-pipeline-step-info">
              <div className="pw-pipeline-step-name">{def.label}</div>
              <div className="pw-pipeline-step-sub">{sub}</div>
            </div>
            {stage.status === 'done' && <span className="pw-pipeline-check">✓</span>}
            {stage.status === 'running' && <div className="pw-pipeline-spin" />}
            {stage.status === 'failed' && <span className="pw-pipeline-x">✗</span>}
          </div>
        )
      })}

      {status === 'success' && previewUrl && (
        <a href={previewUrl} target="_blank" rel="noopener noreferrer" className="pw-pipeline-preview-btn">
          🌐 Ver mi app →
        </a>
      )}

      {status === 'error' && (
        <p className="pw-pipeline-error-msg">
          La app anterior sigue funcionando mientras resolvemos esto.
        </p>
      )}

      {status === 'error' && (
        <button className="pw-pipeline-retry-btn" onClick={onRetry}>
          🔁 Pedirle a la IA que reintente
        </button>
      )}

      <div className={`pw-pipeline-hint pw-pipeline-hint--${status}`}>{hint}</div>
    </div>
  )
}
