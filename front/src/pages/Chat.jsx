import { useState, useRef, useEffect, useCallback } from 'react'
import {
  Send, Trash2, Sparkles, Bot, User, Copy, Check,
  Plus, MessageSquare, ChevronLeft, ChevronRight, Pencil
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import { useAuth } from '../context/AuthContext'
import './Chat.css'

const LITELLM_URL = 'https://litellm.allaria.xyz/v1/chat/completions'
const LITELLM_KEY = 'sk-eWkdUVfWsfB4YVYHi935aw'

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
      { id: 'anthropic/claude-opus-4', label: 'Opus 4', desc: 'Claude Opus 4' },
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

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
}

function getStorageKey(userId) {
  return `allaria_chats_${userId}`
}

function loadChats(userId) {
  try {
    const raw = localStorage.getItem(getStorageKey(userId))
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function saveChats(userId, chats) {
  localStorage.setItem(getStorageKey(userId), JSON.stringify(chats))
}

function createNewChat() {
  return {
    id: generateId(),
    title: 'Nuevo chat',
    messages: [WELCOME_MSG],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

function inferTitle(messages) {
  const firstUser = messages.find(m => m.role === 'user')
  if (!firstUser) return 'Nuevo chat'
  const text = firstUser.content.slice(0, 50)
  return text.length < firstUser.content.length ? text + '...' : text
}

export default function Chat() {
  const { user } = useAuth()
  const userId = user?.id || 'anonymous'
  const userName = user?.name || 'Vos'
  const userPicture = user?.picture

  // Chats
  const [chats, setChats] = useState([])
  const [activeChatId, setActiveChatId] = useState(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)

  // Chat state
  const [selectedModel, setSelectedModel] = useState(PROVIDERS[0].models[0].id)
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [copiedIdx, setCopiedIdx] = useState(null)
  const [editingChatId, setEditingChatId] = useState(null)
  const [editTitle, setEditTitle] = useState('')

  const messagesEndRef = useRef(null)
  const inputRef = useRef(null)

  const activeChat = chats.find(c => c.id === activeChatId)
  const messages = activeChat?.messages || []

  // Load chats for this Google user
  useEffect(() => {
    const loaded = loadChats(userId)
    if (loaded.length === 0) {
      const first = createNewChat()
      setChats([first])
      setActiveChatId(first.id)
      saveChats(userId, [first])
    } else {
      setChats(loaded)
      setActiveChatId(loaded[0].id)
    }
  }, [userId])

  const persistChats = useCallback((updated) => {
    setChats(updated)
    saveChats(userId, updated)
  }, [userId])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Chat management
  const createChat = () => {
    const chat = createNewChat()
    const updated = [chat, ...chats]
    persistChats(updated)
    setActiveChatId(chat.id)
  }

  const selectChat = (id) => {
    setActiveChatId(id)
  }

  const deleteChat = (id) => {
    const updated = chats.filter(c => c.id !== id)
    if (updated.length === 0) {
      const fresh = createNewChat()
      persistChats([fresh])
      setActiveChatId(fresh.id)
    } else {
      persistChats(updated)
      if (activeChatId === id) setActiveChatId(updated[0].id)
    }
  }

  const startEditTitle = (chat) => {
    setEditingChatId(chat.id)
    setEditTitle(chat.title)
  }

  const saveTitle = () => {
    if (!editTitle.trim()) return
    const updated = chats.map(c =>
      c.id === editingChatId ? { ...c, title: editTitle.trim() } : c
    )
    persistChats(updated)
    setEditingChatId(null)
  }

  // Send message
  const sendMessage = async () => {
    if (!input.trim() || !activeChat) return
    setIsLoading(true)

    const userMsg = { role: 'user', content: input.trim() }
    const updatedMessages = [...messages, userMsg]

    let updated = chats.map(c =>
      c.id === activeChatId
        ? { ...c, messages: updatedMessages, updatedAt: new Date().toISOString() }
        : c
    )
    persistChats(updated)
    setInput('')

    try {
      const { model: modelInfo } = getSelectedModelInfo(selectedModel)
      const systemMsg = {
        role: 'system',
        content: `Sos el asistente IA de Allaria Hub. Estás corriendo como ${modelInfo.desc}. Si te preguntan qué modelo sos, respondé que sos ${modelInfo.desc}.`,
      }
      const apiMessages = [
        systemMsg,
        ...updatedMessages.map(m => ({
          role: m.role,
          content: m.content,
        })),
      ]

      const res = await fetch(LITELLM_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${LITELLM_KEY}`,
        },
        body: JSON.stringify({
          model: selectedModel,
          messages: apiMessages,
          temperature: 0.7,
          max_tokens: 4096,
        }),
      })

      const data = await res.json()

      if (data.error) {
        throw new Error(data.error.message || JSON.stringify(data.error))
      }

      const text = data.choices?.[0]?.message?.content || 'Sin respuesta.'
      const assistantMsg = { role: 'assistant', content: text }
      const finalMessages = [...updatedMessages, assistantMsg]

      const autoTitle = updatedMessages.filter(m => m.role === 'user').length === 1
        ? inferTitle(updatedMessages)
        : null

      updated = chats.map(c =>
        c.id === activeChatId
          ? {
              ...c,
              messages: finalMessages,
              updatedAt: new Date().toISOString(),
              ...(autoTitle && c.title === 'Nuevo chat' ? { title: autoTitle } : {}),
            }
          : c
      )
      persistChats(updated)
    } catch (err) {
      const errorMsg = { role: 'assistant', content: `**Error:** ${err.message}\n\nRevisá la conexión con el servidor LiteLLM.` }
      updated = chats.map(c =>
        c.id === activeChatId
          ? { ...c, messages: [...updatedMessages, errorMsg], updatedAt: new Date().toISOString() }
          : c
      )
      persistChats(updated)
    } finally {
      setIsLoading(false)
      inputRef.current?.focus()
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

  const clearChat = () => {
    if (!activeChat) return
    const updated = chats.map(c =>
      c.id === activeChatId
        ? { ...c, messages: [WELCOME_MSG], title: 'Nuevo chat', updatedAt: new Date().toISOString() }
        : c
    )
    persistChats(updated)
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
              onClick={() => selectChat(chat.id)}
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

      {/* Toggle sidebar */}
      <button
        className="chat-sidebar-toggle"
        onClick={() => setSidebarOpen(!sidebarOpen)}
        style={{ left: sidebarOpen ? '260px' : '0' }}
      >
        {sidebarOpen ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
      </button>

      {/* Main chat area */}
      <div className="chat-main" style={{ marginLeft: sidebarOpen ? '260px' : '0' }}>
        {/* Header */}
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
            <button className="btn btn-outline btn-sm" onClick={clearChat} title="Limpiar chat">
              <Trash2 size={14} />
            </button>
          </div>
        </div>

        {/* Messages */}
        <div className="chat-messages">
          {messages.map((msg, i) => (
            <div key={i} className={`chat-message ${msg.role}`}>
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
                <div className="msg-content">
                  <ReactMarkdown>{msg.content}</ReactMarkdown>
                </div>
                {msg.role === 'assistant' && i > 0 && (
                  <button
                    className="msg-copy"
                    onClick={() => copyMessage(msg.content, i)}
                    title="Copiar"
                  >
                    {copiedIdx === i ? <Check size={13} /> : <Copy size={13} />}
                    {copiedIdx === i ? 'Copiado' : 'Copiar'}
                  </button>
                )}
              </div>
            </div>
          ))}

          {isLoading && (
            <div className="chat-message assistant">
              <div className="msg-avatar">
                <Bot size={18} />
              </div>
              <div className="msg-body">
                <div className="typing-indicator">
                  <span />
                  <span />
                  <span />
                </div>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div className="chat-input-area">
          <div className="chat-input-container">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Escribí tu mensaje..."
              rows={1}
              disabled={isLoading}
            />
            <button
              className="chat-send-btn"
              onClick={sendMessage}
              disabled={!input.trim() || isLoading}
            >
              <Send size={18} />
            </button>
          </div>
          <div className="chat-input-hint">
            Enter para enviar · Shift+Enter para nueva línea
          </div>
        </div>
      </div>
    </div>
  )
}
