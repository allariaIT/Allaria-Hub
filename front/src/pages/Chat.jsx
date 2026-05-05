import { useState, useRef, useEffect } from 'react'
import {
  Send, Trash2, Sparkles, Bot, User, Copy, Check,
  Plus, MessageSquare, ChevronLeft, ChevronRight, Pencil,
  Paperclip, X, FileText, Image as ImageIcon,
  Mail, Calendar, CheckSquare, HardDrive, ShieldAlert
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import { useAuth } from '../context/AuthContext'
import { api } from '../lib/api'
import ConnectorPicker from '../components/ConnectorPicker'
import './Chat.css'

const PROVIDERS = [
  {
    name: 'Gemini',
    logo: 'https://www.google.com/s2/favicons?sz=64&domain=gemini.google.com',
    color: '#4285F4',
    colorLight: 'rgba(66, 133, 244, 0.1)',
    models: [
      { id: 'gemini/gemini-2.5-flash', label: 'Rápido', desc: 'Gemini 2.5 Flash' },
      { id: 'gemini/gemini-2.5-pro', label: 'Pensar', desc: 'Gemini 2.5 Pro' },
    ],
  },
  {
    name: 'ChatGPT',
    logo: 'https://www.google.com/s2/favicons?sz=64&domain=openai.com',
    color: '#10A37F',
    colorLight: 'rgba(16, 163, 127, 0.1)',
    models: [
      { id: 'openai/gpt-4-turbo', label: 'Rápido', desc: 'GPT-4 Turbo' },
      { id: 'openai/gpt-4o', label: 'Pensar', desc: 'GPT-4o' },
    ],
  },
  {
    name: 'Claude',
    logo: 'https://www.google.com/s2/favicons?sz=64&domain=claude.ai',
    color: '#D97757',
    colorLight: 'rgba(217, 119, 87, 0.1)',
    models: [
      { id: 'claude-sonnet-4-5', label: 'Sonnet 4.5', desc: 'Claude Sonnet 4.5' },
    ],
  },
]

function getSelectedModelInfo(modelId) {
  for (const p of PROVIDERS) {
    const m = p.models.find(m => m.id === modelId)
    if (m) return { provider: p, model: m }
  }
  return { provider: PROVIDERS[0], model: PROVIDERS[0].models[0] }
}

const WELCOME_MSG = {
  role: 'assistant',
  content: '¡Hola! Soy el asistente IA de Allaria Hub.\n\n¿En qué puedo ayudarte hoy?\n- Código y arquitectura\n- Análisis de datos\n- Documentación técnica\n- Ideas y brainstorming',
}

const TOOL_ICONS = {
  gmail_send: Mail,
  calendar_create: Calendar,
  tasks_create: CheckSquare,
  tasks_complete: CheckSquare,
}

const TOOL_LABELS = {
  gmail_send: 'Enviar email',
  calendar_create: 'Crear evento',
  tasks_create: 'Crear tarea',
  tasks_complete: 'Completar tarea',
}

function ConfirmationCard({ confirmation }) {
  const { toolName, args } = confirmation
  const Icon = TOOL_ICONS[toolName] || ShieldAlert
  const label = TOOL_LABELS[toolName] || toolName

  return (
    <div className="confirmation-card">
      <div className="confirmation-card-header">
        <Icon size={16} />
        <span>{label}</span>
      </div>
      <div className="confirmation-card-body">
        {toolName === 'gmail_send' && (
          <>
            <div className="confirmation-field"><strong>Para:</strong> {args.to}</div>
            <div className="confirmation-field"><strong>Asunto:</strong> {args.subject}</div>
            <div className="confirmation-field confirmation-body-preview">{args.body}</div>
          </>
        )}
        {toolName === 'calendar_create' && (
          <>
            <div className="confirmation-field"><strong>Evento:</strong> {args.summary}</div>
            {args.description && <div className="confirmation-field">{args.description}</div>}
            <div className="confirmation-field"><strong>Inicio:</strong> {new Date(args.start).toLocaleString('es-AR')}</div>
            <div className="confirmation-field"><strong>Fin:</strong> {new Date(args.end).toLocaleString('es-AR')}</div>
            {args.location && <div className="confirmation-field"><strong>Lugar:</strong> {args.location}</div>}
            {args.attendees?.length > 0 && <div className="confirmation-field"><strong>Invitados:</strong> {args.attendees.join(', ')}</div>}
          </>
        )}
        {toolName === 'tasks_create' && (
          <>
            <div className="confirmation-field"><strong>Tarea:</strong> {args.title}</div>
            {args.notes && <div className="confirmation-field">{args.notes}</div>}
            {args.due && <div className="confirmation-field"><strong>Vence:</strong> {new Date(args.due).toLocaleDateString('es-AR')}</div>}
          </>
        )}
        {toolName === 'tasks_complete' && (
          <div className="confirmation-field"><strong>ID:</strong> {args.taskId}</div>
        )}
      </div>
    </div>
  )
}

export default function Chat() {
  const { user } = useAuth()
  const userName = user?.name || 'Vos'
  const userPicture = user?.picture

  const [chats, setChats] = useState([])
  const [activeChatId, setActiveChatId] = useState(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [loadingChats, setLoadingChats] = useState(true)

  const [selectedModel, setSelectedModel] = useState(PROVIDERS[0].models[0].id)
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [copiedIdx, setCopiedIdx] = useState(null)
  const [editingChatId, setEditingChatId] = useState(null)
  const [editTitle, setEditTitle] = useState('')
  const [attachments, setAttachments] = useState([])
  const [toast, setToast] = useState(null)
  const [activeConnectors, setActiveConnectors] = useState([])
  const [pendingConfirmation, setPendingConfirmation] = useState(null)

  const messagesEndRef = useRef(null)
  const inputRef = useRef(null)
  const fileInputRef = useRef(null)

  const activeChat = chats.find(c => c.id === activeChatId)
  const messages = activeChat?.messages || []

  // Load chats from backend
  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const data = await api.getChats()
        if (cancelled) return
        if (data.length === 0) {
          const chat = await api.createChat('Nuevo chat')
          setChats([{ ...chat, messages: [WELCOME_MSG] }])
          setActiveChatId(chat.id)
        } else {
          const withWelcome = data.map(c =>
            c.messages.length === 0 ? { ...c, messages: [WELCOME_MSG] } : c
          )
          setChats(withWelcome)
          setActiveChatId(withWelcome[0].id)
        }
      } catch (err) {
        console.error('Error loading chats:', err)
      } finally {
        if (!cancelled) setLoadingChats(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const createChat = async () => {
    try {
      const chat = await api.createChat('Nuevo chat')
      setChats(prev => [{ ...chat, messages: [WELCOME_MSG] }, ...prev])
      setActiveChatId(chat.id)
    } catch (err) {
      console.error('Error creating chat:', err)
    }
  }

  const deleteChat = async (id) => {
    try {
      await api.deleteChat(id)
      const remaining = chats.filter(c => c.id !== id)
      if (remaining.length === 0) {
        const chat = await api.createChat('Nuevo chat')
        setChats([{ ...chat, messages: [WELCOME_MSG] }])
        setActiveChatId(chat.id)
      } else {
        setChats(remaining)
        if (activeChatId === id) setActiveChatId(remaining[0].id)
      }
    } catch (err) {
      console.error('Error deleting chat:', err)
    }
  }

  const startEditTitle = (chat) => {
    setEditingChatId(chat.id)
    setEditTitle(chat.title)
  }

  const saveTitle = async () => {
    if (!editTitle.trim()) return
    try {
      await api.updateChat(editingChatId, editTitle.trim())
      setChats(prev => prev.map(c =>
        c.id === editingChatId ? { ...c, title: editTitle.trim() } : c
      ))
    } catch (err) {
      console.error('Error updating title:', err)
    }
    setEditingChatId(null)
  }

  const showToast = (message) => {
    setToast(message)
    setTimeout(() => setToast(null), 4000)
  }

  const toggleConnector = (id) => {
    setActiveConnectors(prev =>
      prev.includes(id) ? prev.filter(c => c !== id) : [...prev, id]
    )
  }

  const GEMINI_FLASH = 'gemini/gemini-2.5-flash'

  const handleFileSelect = (e) => {
    const files = Array.from(e.target.files)

    // Switch to Gemini if not already
    if (selectedModel !== GEMINI_FLASH && selectedModel !== 'gemini/gemini-2.5-pro') {
      setSelectedModel(GEMINI_FLASH)
      showToast('📎 Se cambió a Gemini — es el mejor modelo para analizar archivos adjuntos')
    }

    files.forEach(file => {
      const isImage = file.type.startsWith('image/')
      const isText = /^text\/|json|javascript|typescript|css|html|xml|csv|markdown|yaml/.test(file.type)
        || /\.(txt|md|py|js|ts|jsx|tsx|css|html|json|csv|yaml|yml|sh|sql|env)$/i.test(file.name)

      if (isText) {
        // Read as text
        const textReader = new FileReader()
        textReader.onload = () => {
          setAttachments(prev => [...prev, {
            name: file.name,
            type: file.type,
            size: file.size,
            textContent: textReader.result,
            isImage: false,
            isText: true,
          }])
        }
        textReader.readAsText(file)
      } else {
        // Read as base64 (images, PDFs, audio, video)
        const reader = new FileReader()
        reader.onload = () => {
          setAttachments(prev => [...prev, {
            name: file.name,
            type: file.type,
            size: file.size,
            base64: reader.result,
            isImage,
            isText: false,
          }])
        }
        reader.readAsDataURL(file)
      }
    })
    e.target.value = ''
  }

  const removeAttachment = (idx) => {
    setAttachments(prev => prev.filter((_, i) => i !== idx))
  }

  function buildUserContent(text, files) {
    if (!files.length) return text
    const parts = []
    if (text) parts.push({ type: 'text', text })
    for (const file of files) {
      if (file.isImage || file.type === 'application/pdf') {
        // Imágenes y PDFs van como image_url (Gemini soporta ambos)
        parts.push({
          type: 'image_url',
          image_url: { url: file.base64 },
        })
        if (!file.isImage) {
          parts.push({ type: 'text', text: `[📎 ${file.name}]` })
        }
      } else if (file.isText && file.textContent) {
        // Archivos de texto van como contenido inline
        parts.push({
          type: 'text',
          text: `--- Archivo: ${file.name} ---\n${file.textContent}\n--- Fin archivo ---`,
        })
      } else {
        // Otros archivos binarios (audio, video) van como image_url
        parts.push({
          type: 'image_url',
          image_url: { url: file.base64 },
        })
        parts.push({ type: 'text', text: `[📎 ${file.name}]` })
      }
    }
    return parts
  }

  function getDisplayContent(msg) {
    if (typeof msg.content === 'string') return msg.content
    if (Array.isArray(msg.content)) {
      return msg.content
        .filter(p => p.type === 'text')
        .map(p => p.text)
        .join('\n')
    }
    return ''
  }

  function getImages(msg) {
    if (!Array.isArray(msg.content)) return []
    return msg.content
      .filter(p => p.type === 'image_url')
      .map(p => p.image_url.url)
  }

  const sendMessage = async () => {
    if ((!input.trim() && !attachments.length) || !activeChat) return
    setIsLoading(true)

    const content = buildUserContent(input.trim(), attachments)
    const userMsg = { role: 'user', content }
    const updatedMessages = [...messages, userMsg]

    // Optimistic UI update
    setChats(prev => prev.map(c =>
      c.id === activeChatId ? { ...c, messages: updatedMessages } : c
    ))
    setInput('')
    setAttachments([])

    try {
      const { model: modelInfo } = getSelectedModelInfo(selectedModel)
      const systemMsg = {
        role: 'system',
        content: [
          `Sos el asistente IA de Allaria Hub. Estás corriendo como ${modelInfo.desc}. Si te preguntan qué modelo sos, respondé que sos ${modelInfo.desc}. Podés recibir y analizar archivos adjuntos como imágenes, PDFs, audio, video y archivos de texto/código. Cuando el usuario adjunta un archivo, lo recibís directamente en el mensaje y podés analizarlo. No digas que no podés leer archivos.`,
          activeConnectors.includes('gmail') && 'Tenés acceso al Gmail del usuario. Podés listar, leer, buscar y enviar emails. Antes de enviar un email, SIEMPRE mostrá el borrador y pedí confirmación.',
          activeConnectors.includes('calendar') && 'Tenés acceso al Google Calendar del usuario. Podés ver próximos eventos, crear eventos y buscar. Antes de crear un evento, SIEMPRE confirmá los detalles con el usuario.',
          activeConnectors.includes('tasks') && 'Tenés acceso a Google Tasks del usuario. Podés listar tareas, crear nuevas y marcar como completadas.',
          activeConnectors.includes('drive') && 'Tenés acceso al Google Drive del usuario. Podés listar archivos recientes, buscar por nombre y ver detalles.',
        ].filter(Boolean).join(' '),
      }

      const apiMessages = [
        systemMsg,
        ...updatedMessages
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .map(m => ({ role: m.role, content: m.content })),
      ]

      const data = await api.sendMessage(activeChatId, selectedModel, apiMessages, activeConnectors)

      if (data._pendingConfirmations) {
        // El LLM quiere ejecutar acciones que necesitan confirmación
        setPendingConfirmation({
          confirmations: data._pendingConfirmations,
          llmMessages: data._llmMessages,
          model: data._model,
          connectors: data._connectors,
          chatId: data._chatId,
        })
        // Mostrar preview en el chat
        const previewMsg = {
          role: 'assistant',
          content: '',
          _confirmations: data._pendingConfirmations,
        }
        setChats(prev => prev.map(c =>
          c.id === activeChatId ? { ...c, messages: [...updatedMessages, previewMsg] } : c
        ))
        setIsLoading(false)
        return
      }

      const assistantContent = data.choices?.[0]?.message?.content || 'Sin respuesta.'
      const assistantMsg = { role: 'assistant', content: assistantContent }

      setChats(prev => prev.map(c =>
        c.id === activeChatId
          ? {
              ...c,
              messages: [...updatedMessages, assistantMsg],
              ...(data._chatTitle ? { title: data._chatTitle } : {}),
            }
          : c
      ))
    } catch (err) {
      const errorMsg = { role: 'assistant', content: `**Error:** ${err.message}\n\nRevisá la conexión con el servidor.` }
      setChats(prev => prev.map(c =>
        c.id === activeChatId ? { ...c, messages: [...updatedMessages, errorMsg] } : c
      ))
    } finally {
      setIsLoading(false)
      inputRef.current?.focus()
    }
  }

  const handleConfirmation = async (approved) => {
    if (!pendingConfirmation) return
    setIsLoading(true)

    const { confirmations, llmMessages, model, connectors, chatId } = pendingConfirmation
    const resolvedConfs = confirmations.map(c => ({ ...c, approved }))

    // Quitar el mensaje de preview
    const currentMessages = messages.filter(m => !m._confirmations)

    try {
      const data = await api.confirmAction(chatId, model, connectors, llmMessages, resolvedConfs)

      if (data._pendingConfirmations) {
        setPendingConfirmation({
          confirmations: data._pendingConfirmations,
          llmMessages: data._llmMessages,
          model: data._model,
          connectors: data._connectors,
          chatId: data._chatId,
        })
        const previewMsg = {
          role: 'assistant',
          content: '',
          _confirmations: data._pendingConfirmations,
        }
        setChats(prev => prev.map(c =>
          c.id === activeChatId ? { ...c, messages: [...currentMessages, previewMsg] } : c
        ))
        setIsLoading(false)
        return
      }

      setPendingConfirmation(null)
      const assistantContent = data.choices?.[0]?.message?.content || 'Sin respuesta.'
      const assistantMsg = { role: 'assistant', content: assistantContent }

      setChats(prev => prev.map(c =>
        c.id === activeChatId ? { ...c, messages: [...currentMessages, assistantMsg] } : c
      ))
    } catch (err) {
      setPendingConfirmation(null)
      const errorMsg = { role: 'assistant', content: `**Error:** ${err.message}` }
      setChats(prev => prev.map(c =>
        c.id === activeChatId ? { ...c, messages: [...currentMessages, errorMsg] } : c
      ))
    } finally {
      setIsLoading(false)
    }
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  const copyMessage = (text, idx) => {
    navigator.clipboard.writeText(text)
    setCopiedIdx(idx)
    setTimeout(() => setCopiedIdx(null), 2000)
  }

  const clearChat = async () => {
    if (!activeChat) return
    try {
      await api.clearChat(activeChat.id)
      setChats(prev => prev.map(c =>
        c.id === activeChatId ? { ...c, messages: [WELCOME_MSG], title: 'Nuevo chat' } : c
      ))
    } catch (err) {
      console.error('Error clearing chat:', err)
    }
  }

  if (loadingChats) {
    return (
      <div className="chat-page" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div className="typing-indicator"><span /><span /><span /></div>
      </div>
    )
  }

  return (
    <div className="chat-page">
      {/* Chat Sidebar */}
      <div className={`chat-sidebar ${sidebarOpen ? 'open' : ''}`}>
        <div className="chat-sidebar-header">
          <h3>Conversaciones</h3>
          <button className="chat-sidebar-new" onClick={createChat} title="Nuevo chat">
            <Plus size={16} />
          </button>
        </div>

        <div className="chat-sidebar-list">
          {chats.map(chat => (
            <div
              key={chat.id}
              className={`chat-sidebar-item ${chat.id === activeChatId ? 'active' : ''}`}
              onClick={() => setActiveChatId(chat.id)}
            >
              <MessageSquare size={14} className="chat-sidebar-item-icon" />
              {editingChatId === chat.id ? (
                <input
                  className="chat-sidebar-edit-input"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  onBlur={saveTitle}
                  onKeyDown={(e) => e.key === 'Enter' && saveTitle()}
                  onClick={(e) => e.stopPropagation()}
                  autoFocus
                />
              ) : (
                <span className="chat-sidebar-item-title">{chat.title}</span>
              )}
              <div className="chat-sidebar-item-actions">
                <button onClick={(e) => { e.stopPropagation(); startEditTitle(chat) }} title="Renombrar">
                  <Pencil size={12} />
                </button>
                <button onClick={(e) => { e.stopPropagation(); deleteChat(chat.id) }} title="Eliminar">
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="chat-sidebar-user-info">
          {userPicture && (
            <img src={userPicture} alt={userName} className="chat-sidebar-avatar" referrerPolicy="no-referrer" />
          )}
          <span>{userName}</span>
        </div>
      </div>

      <button
        className="chat-sidebar-toggle"
        onClick={() => setSidebarOpen(!sidebarOpen)}
        style={{ left: sidebarOpen ? '260px' : '0' }}
      >
        {sidebarOpen ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
      </button>

      <div className="chat-main" style={{ marginLeft: sidebarOpen ? '260px' : '0' }}>
        <div className="chat-header">
          <div className="chat-header-left">
            <div className="chat-header-icon">
              <Sparkles size={18} />
            </div>
            <div>
              <h2>{activeChat?.title || 'Chat IA'}</h2>
              <div className="model-picker">
                {PROVIDERS.map(provider => {
                  const isActive = provider.models.some(m => m.id === selectedModel)
                  return (
                    <div
                      key={provider.name}
                      className={`model-provider ${isActive ? 'active' : ''}`}
                      style={{ '--provider-color': provider.color, '--provider-color-light': provider.colorLight }}
                    >
                      <div className="model-provider-btn">
                        <img src={provider.logo} alt={provider.name} className="model-provider-logo" />
                        <span>{provider.name}</span>
                      </div>
                      {provider.models.length > 1 ? (
                        <div className="model-dropdown">
                          {provider.models.map(m => (
                            <button
                              key={m.id}
                              className={`model-dropdown-item ${selectedModel === m.id ? 'selected' : ''}`}
                              onClick={() => setSelectedModel(m.id)}
                            >
                              <span className="model-dropdown-label">{m.label}</span>
                              <span className="model-dropdown-desc">{m.desc}</span>
                            </button>
                          ))}
                        </div>
                      ) : (
                        <button
                          className="model-provider-single"
                          onClick={() => setSelectedModel(provider.models[0].id)}
                        />
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
          <div className="chat-header-actions">
            <ConnectorPicker
              activeConnectors={activeConnectors}
              onToggle={toggleConnector}
              onToast={showToast}
            />
            <button className="btn btn-outline btn-sm" onClick={clearChat} title="Limpiar chat">
              <Trash2 size={14} />
            </button>
          </div>
        </div>

        <div className="chat-messages">
          {messages.map((msg, i) => (
            <div key={msg.id || i} className={`chat-message ${msg.role}`}>
              <div className="msg-avatar">
                {msg.role === 'assistant' ? (
                  <Bot size={18} />
                ) : userPicture ? (
                  <img src={userPicture} alt="" className="msg-avatar-img" referrerPolicy="no-referrer" />
                ) : (
                  <User size={18} />
                )}
              </div>
              <div className="msg-body">
                <div className="msg-meta">
                  <span className="msg-name">
                    {msg.role === 'assistant' ? 'Allaria IA' : userName}
                  </span>
                </div>
                {getImages(msg).length > 0 && (
                  <div className="msg-images">
                    {getImages(msg).map((src, j) => (
                      <img key={j} src={src} alt="Adjunto" className="msg-attached-img" />
                    ))}
                  </div>
                )}
                {msg._confirmations ? (
                  <div className="confirmation-cards">
                    {msg._confirmations.map((conf, ci) => (
                      <ConfirmationCard key={ci} confirmation={conf} />
                    ))}
                    <div className="confirmation-actions">
                      <button
                        className="confirmation-btn confirm"
                        onClick={() => handleConfirmation(true)}
                        disabled={isLoading}
                      >
                        <Check size={15} />
                        Confirmar
                      </button>
                      <button
                        className="confirmation-btn cancel"
                        onClick={() => handleConfirmation(false)}
                        disabled={isLoading}
                      >
                        <X size={15} />
                        Cancelar
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="msg-content">
                      <ReactMarkdown>{getDisplayContent(msg)}</ReactMarkdown>
                    </div>
                    {msg.role === 'assistant' && i > 0 && (
                      <button className="msg-copy" onClick={() => copyMessage(msg.content, i)} title="Copiar">
                        {copiedIdx === i ? <Check size={13} /> : <Copy size={13} />}
                        {copiedIdx === i ? 'Copiado' : 'Copiar'}
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          ))}

          {isLoading && (
            <div className="chat-message assistant">
              <div className="msg-avatar"><Bot size={18} /></div>
              <div className="msg-body">
                <div className="typing-indicator"><span /><span /><span /></div>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        <div className="chat-input-area">
          {attachments.length > 0 && (
            <div className="attachments-preview">
              {attachments.map((file, i) => (
                <div key={i} className="attachment-chip">
                  {file.isImage ? (
                    <img src={file.base64} alt={file.name} className="attachment-thumb" />
                  ) : (
                    <FileText size={16} />
                  )}
                  <span className="attachment-name">{file.name}</span>
                  <button className="attachment-remove" onClick={() => removeAttachment(i)}>
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="chat-input-container">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,audio/*,video/*,.pdf,.txt,.csv,.json,.md,.py,.js,.ts,.jsx,.tsx,.html,.css,.doc,.docx,.xls,.xlsx"
              onChange={handleFileSelect}
              style={{ display: 'none' }}
            />
            <button
              className="chat-attach-btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={isLoading || !!pendingConfirmation}
              title="Adjuntar archivo"
            >
              <Paperclip size={18} />
            </button>
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Escribí tu mensaje..."
              rows={1}
              disabled={isLoading || !!pendingConfirmation}
            />
            <button
              className="chat-send-btn"
              onClick={sendMessage}
              disabled={(!input.trim() && !attachments.length) || isLoading || !!pendingConfirmation}
            >
              <Send size={18} />
            </button>
          </div>
          <div className="chat-input-hint">
            Enter para enviar · Shift+Enter para nueva línea · 📎 para adjuntar
          </div>
        </div>

        {toast && (
          <div className="chat-toast">
            <span>{toast}</span>
          </div>
        )}
      </div>
    </div>
  )
}
