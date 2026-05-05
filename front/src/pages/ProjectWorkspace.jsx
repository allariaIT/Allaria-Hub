import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  ArrowLeft, ExternalLink, GitBranch, Pencil, Check, X,
  Send, Bot, User, Copy, CheckCheck, Loader2, Code, GitBranch as GitPush,
  ShieldAlert, RotateCcw
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import { api } from '../lib/api'
import { useAuth } from '../context/AuthContext'
import './ProjectWorkspace.css'

const SANDBOX_SYSTEM_PROMPT = `Sos el asistente de desarrollo de este proyecto web.

REGLAS IMPORTANTES:
1. Cuando el usuario te pregunte "¿en qué estábamos?", "¿qué hicimos?", "¿qué hay hasta ahora?" o similar, leé PRIMERO el archivo CHANGELOG.md con sandbox_read_file. NO leas todos los archivos del proyecto ni hagas builds innecesarios.
2. Cada vez que modifiques archivos, al final SIEMPRE actualizá CHANGELOG.md agregando una entrada con: fecha, qué se cambió y por qué. Usá formato markdown simple.
3. Después de modificar archivos, SIEMPRE llamá sandbox_build para deployar los cambios.
4. Para pushear a GitLab usá sandbox_push cuando el usuario lo pida.

Tools disponibles: sandbox_write_file, sandbox_read_file, sandbox_list_files, sandbox_build, sandbox_push, sandbox_status.`

const DEFAULT_MODEL = 'claude-sonnet-4-5'

const CONNECTORS = ['sandbox']

const TOOL_PROGRESS = {
  sandbox_write_file:    (a) => `Escribiendo ${a.filePath || 'archivo'}`,
  sandbox_read_file:     (a) => `Leyendo ${a.filePath || 'archivo'}`,
  sandbox_list_files:    ()  => 'Listando archivos',
  sandbox_build:         ()  => 'Buildeando proyecto...',
  sandbox_push:          (a) => `Push: "${a.message || ''}"`,
  sandbox_status:        ()  => 'Revisando estado',
  sandbox_create_project:(a) => `Creando proyecto "${a.name || ''}"`,
}

const STATUS_COLORS = { running: '#22c55e', stopped: '#888', creating: '#eab308', error: '#ef4444' }
const STATUS_LABELS  = { running: 'Activo', stopped: 'Detenido', creating: 'Creando...', error: 'Error' }

export default function ProjectWorkspace() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()

  const [project, setProject]   = useState(null)
  const [chat, setChat]         = useState(null)
  const [messages, setMessages] = useState([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState('')
  const [interrupted, setInterrupted] = useState(false)

  const [editingTitle, setEditingTitle] = useState(false)
  const [editingDesc, setEditingDesc]   = useState(false)
  const [titleDraft, setTitleDraft]     = useState('')
  const [descDraft, setDescDraft]       = useState('')

  const [input, setInput]               = useState('')
  const [selectedModel] = useState(DEFAULT_MODEL)
  const [sending, setSending]           = useState(false)
  const [progress, setProgress]         = useState([])
  const [copied, setCopied]             = useState(null)

  const messagesEndRef = useRef(null)
  const inputRef       = useRef(null)

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
        // Si el último mensaje es del usuario, el backend puede estar procesando en background
        if (msgs.length > 0 && msgs[msgs.length - 1].role === 'user') {
          setInterrupted(true) // se muestra "procesando..." hasta que llegue la respuesta
        }
      } catch (err) {
        setError(err.message)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [id])

  // Polling: si el último mensaje es del usuario (backend procesando en background), esperar respuesta
  useEffect(() => {
    if (!interrupted || sending || !chat) return
    const interval = setInterval(async () => {
      try {
        const chatData = await api.getProjectChat(id)
        const msgs = chatData.messages || []
        if (msgs.length > 0 && msgs[msgs.length - 1].role === 'assistant') {
          setMessages(msgs)
          setInterrupted(false)
          clearInterval(interval)
        }
      } catch {}
    }, 3000)
    return () => clearInterval(interval)
  }, [interrupted, sending, chat, id])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, sending, progress])

  const saveTitle = async () => {
    if (!titleDraft.trim()) return
    try {
      const updated = await api.updateProject(id, { title: titleDraft.trim() })
      setProject(updated)
    } catch {}
    setEditingTitle(false)
  }

  const saveDesc = async () => {
    try {
      const updated = await api.updateProject(id, { description: descDraft })
      setProject(updated)
    } catch {}
    setEditingDesc(false)
  }

  const buildSystemPrompt = () => {
    const projectName = project?.name || ''
    return `${SANDBOX_SYSTEM_PROMPT} El proyecto activo es "${projectName}". Cuando uses las tools de sandbox, el projectName es siempre "${projectName}".`
  }

  const doSend = async (overrideInput) => {
    const text = (overrideInput ?? input).trim()
    if (!text || !chat) return

    setSending(true)
    setProgress([])
    setInterrupted(false)

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

      const response = await api.streamMessage(chat.id, selectedModel, apiMessages, CONNECTORS)

      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: 'Error del servidor' }))
        throw new Error(err.error || 'Error del servidor')
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const parts = buffer.split('\n\n')
        buffer = parts.pop()

        for (const part of parts) {
          if (!part.startsWith('data: ')) continue
          let event
          try { event = JSON.parse(part.slice(6)) } catch { continue }

          if (event.type === 'tool_start') {
            const label = TOOL_PROGRESS[event.name]?.(event.args) ?? event.name
            setProgress(prev => [...prev, { id: `${event.name}-${Date.now()}`, label, status: 'running' }])
          } else if (event.type === 'tool_done') {
            // Marcar el último en running como done
            setProgress(prev => {
              const idx = [...prev].reverse().findIndex(p => p.status === 'running')
              if (idx === -1) return prev
              const realIdx = prev.length - 1 - idx
              return prev.map((p, i) => i === realIdx ? { ...p, status: 'done' } : p)
            })
          } else if (event.type === 'done') {
            setMessages(prev => [...prev, { role: 'assistant', content: event.content }])
            setProgress([])
          } else if (event.type === 'error') {
            setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${event.message}` }])
            setProgress([])
          }
        }
      }
    } catch (err) {
      setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${err.message}` }])
    } finally {
      setSending(false)
      setProgress([])
    }
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      doSend()
    }
  }

  const handleRetry = () => {
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')
    if (!lastUserMsg) return
    const lastIdx = messages.lastIndexOf(lastUserMsg)
    setMessages(prev => prev.slice(0, lastIdx))
    doSend(lastUserMsg.content)
  }

  const copyMsg = (text, idx) => {
    navigator.clipboard.writeText(text)
    setCopied(idx)
    setTimeout(() => setCopied(null), 2000)
  }

  if (loading) return (
    <div className="pw-loading"><Loader2 size={24} className="pw-spin" /></div>
  )

  if (error) return (
    <div className="pw-error">
      <p>{error}</p>
      <button className="btn btn-primary" onClick={() => navigate('/proyectos')}>Volver</button>
    </div>
  )

  if (project?.status === 'creating') return (
    <div className="pw-error">
      <Loader2 size={32} className="pw-spin" style={{ color: '#eab308' }} />
      <p style={{ marginTop: '1rem', fontWeight: 600 }}>El proyecto se está creando...</p>
      <p style={{ fontSize: '13px', color: 'var(--text-tertiary)' }}>Esto puede tardar hasta un minuto. Volvé en unos segundos.</p>
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

  if (error) return (
    <div className="pw-error">
      <p>{error}</p>
      <button className="btn btn-primary" onClick={() => navigate('/proyectos')}>Volver</button>
    </div>
  )

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
                onChange={e => setTitleDraft(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') saveTitle(); if (e.key === 'Escape') setEditingTitle(false) }}
                autoFocus
              />
              <button onClick={saveTitle}><Check size={14} /></button>
              <button onClick={() => setEditingTitle(false)}><X size={14} /></button>
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
                <textarea value={descDraft} onChange={e => setDescDraft(e.target.value)} rows={4} autoFocus />
                <div className="pw-desc-edit-actions">
                  <button className="btn-sm" onClick={saveDesc}><Check size={12} /> Guardar</button>
                  <button className="btn-sm ghost" onClick={() => setEditingDesc(false)}>Cancelar</button>
                </div>
              </div>
            ) : (
              <p className="pw-desc-text" onClick={() => setEditingDesc(true)}>
                {project.description || <span className="pw-desc-empty">+ Agregar descripción</span>}
                <Pencil size={11} className="pw-edit-icon" />
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
          <div className="pw-messages">
            {messages.length === 0 && (
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

            {/* Interrupted / background processing banner */}
            {interrupted && !sending && (
              <div className="pw-interrupted">
                <Loader2 size={13} className="pw-spin" />
                <span>Procesando en segundo plano...</span>
              </div>
            )}

            {/* Progress updates */}
            {progress.length > 0 && (
              <div className="pw-progress-list">
                {progress.map(p => (
                  <div key={p.id} className={`pw-progress-item pw-progress-${p.status}`}>
                    {p.status === 'running' ? <Loader2 size={12} className="pw-spin" /> : <Check size={12} />}
                    <span>{p.label}</span>
                  </div>
                ))}
              </div>
            )}

            {sending && (
              <div className="pw-msg pw-msg-assistant">
                <div className="pw-msg-avatar"><Bot size={14} /></div>
                <div className="pw-msg-body pw-typing">
                  <span /><span /><span />
                </div>
              </div>
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
              placeholder="Pedile a la IA que cree archivos, modifique código, buildee..."
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
