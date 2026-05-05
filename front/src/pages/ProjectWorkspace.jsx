import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  ArrowLeft, ExternalLink, GitBranch, Pencil, Check, X,
  Send, Bot, User, Copy, CheckCheck, Loader2, Code, GitBranch as GitPush,
  ShieldAlert, Square
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import { api } from '../lib/api'
import { useAuth } from '../context/AuthContext'
import './ProjectWorkspace.css'

const SANDBOX_SYSTEM_PROMPT = 'Sos el asistente de desarrollo de este proyecto web. Tenés acceso al sandbox: podés crear y modificar archivos con sandbox_write_file, leer archivos con sandbox_read_file, ver la estructura con sandbox_list_files, y buildear con sandbox_build para que el usuario vea los cambios en la preview. Después de modificar archivos, SIEMPRE llamá sandbox_build. Podés pushear a GitLab con sandbox_push cuando el usuario lo pida.'

const TOOL_ICONS = {
  sandbox_create_project: Code,
  sandbox_write_file: Code,
  sandbox_read_file: Code,
  sandbox_list_files: Code,
  sandbox_build: Code,
  sandbox_push: GitPush,
  sandbox_status: Code,
}

const TOOL_LABELS = {
  sandbox_create_project: 'Crear proyecto',
  sandbox_write_file: 'Escribir archivo',
  sandbox_read_file: 'Leer archivo',
  sandbox_list_files: 'Listar archivos',
  sandbox_build: 'Buildear proyecto',
  sandbox_push: 'Push a GitLab',
  sandbox_status: 'Estado del proyecto',
}

const STATUS_COLORS = { running: '#22c55e', stopped: '#888', creating: '#eab308', error: '#ef4444' }
const STATUS_LABELS = { running: 'Activo', stopped: 'Detenido', creating: 'Creando...', error: 'Error' }

const MODELS = [
  { id: 'gemini/gemini-2.5-flash', label: 'Gemini Flash', logo: 'https://www.google.com/s2/favicons?sz=64&domain=gemini.google.com' },
  { id: 'gemini/gemini-2.5-pro',   label: 'Gemini Pro',   logo: 'https://www.google.com/s2/favicons?sz=64&domain=gemini.google.com' },
  { id: 'openai/gpt-4-turbo',      label: 'GPT-4 Turbo',  logo: 'https://www.google.com/s2/favicons?sz=64&domain=openai.com' },
  { id: 'openai/gpt-4o',           label: 'GPT-4o',        logo: 'https://www.google.com/s2/favicons?sz=64&domain=openai.com' },
  { id: 'claude-sonnet-4-5',       label: 'Claude Sonnet', logo: 'https://www.google.com/s2/favicons?sz=64&domain=claude.ai' },
]
const CONNECTORS = ['sandbox']

function ConfirmationCard({ conf }) {
  const Icon = TOOL_ICONS[conf.toolName] || ShieldAlert
  const label = TOOL_LABELS[conf.toolName] || conf.toolName
  return (
    <div className="pw-confirm-card">
      <div className="pw-confirm-header">
        <Icon size={14} />
        <span>{label}</span>
      </div>
      <div className="pw-confirm-body">
        {conf.toolName === 'sandbox_write_file' && (
          <div className="pw-confirm-field"><strong>Archivo:</strong> {conf.args.filePath}</div>
        )}
        {conf.toolName === 'sandbox_push' && (
          <>
            <div className="pw-confirm-field"><strong>Proyecto:</strong> {conf.args.projectName}</div>
            <div className="pw-confirm-field"><strong>Commit:</strong> {conf.args.message}</div>
          </>
        )}
        {conf.toolName === 'sandbox_create_project' && (
          <>
            <div className="pw-confirm-field"><strong>Nombre:</strong> {conf.args.name}</div>
            <div className="pw-confirm-field"><strong>Título:</strong> {conf.args.title}</div>
          </>
        )}
      </div>
    </div>
  )
}

export default function ProjectWorkspace() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()

  const [project, setProject] = useState(null)
  const [chat, setChat] = useState(null)
  const [messages, setMessages] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // Edit project info
  const [editingTitle, setEditingTitle] = useState(false)
  const [editingDesc, setEditingDesc] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [descDraft, setDescDraft] = useState('')

  // Chat state
  const [input, setInput] = useState('')
  const [selectedModel, setSelectedModel] = useState(MODELS[0].id)
  const [sending, setSending] = useState(false)
  const [copied, setCopied] = useState(null)
  const [pendingConfirmation, setPendingConfirmation] = useState(null)

  const messagesEndRef = useRef(null)
  const inputRef = useRef(null)

  useEffect(() => {
    async function load() {
      try {
        const [proj, chatData] = await Promise.all([
          api.getProject(id),
          api.getProjectChat(id),
        ])
        setProject(proj)
        setChat(chatData)
        setMessages(chatData.messages || [])
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

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, sending])

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

  const sendMessage = async () => {
    if (!input.trim() || !chat) return
    setSending(true)

    const userMsg = { role: 'user', content: input.trim() }
    const newMessages = [...messages, userMsg]
    setMessages(newMessages)
    setInput('')

    try {
      const systemMsg = { role: 'system', content: buildSystemPrompt() }
      const apiMessages = [
        systemMsg,
        ...newMessages
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .map(m => ({ role: m.role, content: m.content })),
      ]

      const data = await api.sendMessage(chat.id, selectedModel, apiMessages, CONNECTORS)

      if (data._pendingConfirmations) {
        setPendingConfirmation({
          confirmations: data._pendingConfirmations,
          llmMessages: data._llmMessages,
          model: data._model,
          connectors: data._connectors,
          chatId: data._chatId,
        })
        setSending(false)
        return
      }

      const assistantMsg = { role: 'assistant', content: data.choices?.[0]?.message?.content || '' }
      setMessages(prev => [...prev, assistantMsg])
    } catch (err) {
      setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${err.message}` }])
    } finally {
      setSending(false)
    }
  }

  const handleConfirm = async (approved) => {
    if (!pendingConfirmation) return
    setSending(true)
    const { confirmations, llmMessages, model, connectors, chatId } = pendingConfirmation
    setPendingConfirmation(null)

    try {
      const data = await api.confirmAction(
        chatId, model, connectors, llmMessages,
        confirmations.map(c => ({ ...c, approved }))
      )

      if (data._pendingConfirmations) {
        setPendingConfirmation({
          confirmations: data._pendingConfirmations,
          llmMessages: data._llmMessages,
          model: data._model,
          connectors: data._connectors,
          chatId: data._chatId,
        })
        return
      }

      const assistantMsg = { role: 'assistant', content: data.choices?.[0]?.message?.content || '' }
      setMessages(prev => [...prev, assistantMsg])
    } catch (err) {
      setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${err.message}` }])
    } finally {
      setSending(false)
    }
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  const copyMsg = (text, idx) => {
    navigator.clipboard.writeText(text)
    setCopied(idx)
    setTimeout(() => setCopied(null), 2000)
  }

  if (loading) return (
    <div className="pw-loading">
      <Loader2 size={24} className="pw-spin" />
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
            <h4>Descripcion</h4>
            {editingDesc ? (
              <div className="pw-desc-edit">
                <textarea
                  value={descDraft}
                  onChange={e => setDescDraft(e.target.value)}
                  rows={4}
                  autoFocus
                />
                <div className="pw-desc-edit-actions">
                  <button className="btn-sm" onClick={saveDesc}><Check size={12} /> Guardar</button>
                  <button className="btn-sm ghost" onClick={() => setEditingDesc(false)}>Cancelar</button>
                </div>
              </div>
            ) : (
              <p className="pw-desc-text" onClick={() => setEditingDesc(true)}>
                {project.description || <span className="pw-desc-empty">+ Agregar descripcion</span>}
                <Pencil size={11} className="pw-edit-icon" />
              </p>
            )}
          </div>

          <div className="pw-sidebar-section">
            <h4>Detalles</h4>
            <div className="pw-detail-row">
              <span>Slug</span>
              <code>{project.name}</code>
            </div>
            <div className="pw-detail-row">
              <span>Template</span>
              <code>{project.template}</code>
            </div>
            {project.port && (
              <div className="pw-detail-row">
                <span>Puerto</span>
                <code>{project.port}</code>
              </div>
            )}
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
                <p>Hola, soy tu asistente para este proyecto. Puedo crear y modificar archivos, buildear la preview y pushear a GitLab. En que empezamos?</p>
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

            {pendingConfirmation && (
              <div className="pw-pending">
                <div className="pw-pending-header">
                  <ShieldAlert size={16} />
                  <span>Accion que requiere confirmacion</span>
                </div>
                {pendingConfirmation.confirmations.map((conf, i) => (
                  <ConfirmationCard key={i} conf={conf} />
                ))}
                <div className="pw-pending-actions">
                  <button className="btn btn-primary" onClick={() => handleConfirm(true)}>Confirmar</button>
                  <button className="btn btn-ghost" onClick={() => handleConfirm(false)}>Cancelar</button>
                </div>
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
            <select
              className="pw-model-select"
              value={selectedModel}
              onChange={e => setSelectedModel(e.target.value)}
              disabled={sending || !!pendingConfirmation}
            >
              {MODELS.map(m => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Pedile a la IA que cree archivos, modifique codigo, buildee..."
              rows={1}
              disabled={sending || !!pendingConfirmation}
            />
            <button
              className="pw-send-btn"
              onClick={sendMessage}
              disabled={!input.trim() || sending || !!pendingConfirmation}
            >
              <Send size={16} />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
