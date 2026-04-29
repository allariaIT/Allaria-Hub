import { useState, useEffect } from 'react'
import { Mail, Unlink, Loader2, CheckCircle2 } from 'lucide-react'
import { api } from '../lib/api'
import './ConnectorPicker.css'

const CONNECTORS = [
  {
    id: 'gmail',
    name: 'Gmail',
    icon: Mail,
    color: '#EA4335',
    colorLight: 'rgba(234, 67, 53, 0.1)',
    desc: 'Leer, buscar y enviar emails',
  },
]

export default function ConnectorPicker({ activeConnectors, onToggle, onToast }) {
  const [connections, setConnections] = useState([])
  const [loading, setLoading] = useState(null)

  useEffect(() => {
    api.getConnectors().then(setConnections).catch(() => {})
  }, [])

  // Detectar callback de OAuth exitoso
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const connected = params.get('connected')
    if (connected) {
      window.history.replaceState({}, '', '/chat')
      api.getConnectors().then(data => {
        setConnections(data)
        onToast(`${connected} conectado correctamente`)
      })
    }
  }, [onToast])

  const isConnected = (id) => connections.some(c => c.provider === id)
  const isActive = (id) => activeConnectors.includes(id)

  const handleClick = async (connector) => {
    if (!isConnected(connector.id)) {
      setLoading(connector.id)
      try {
        const { url } = await api.connectProvider(connector.id)
        window.location.href = url
      } catch (err) {
        onToast(`Error al conectar: ${err.message}`)
        setLoading(null)
      }
      return
    }
    onToggle(connector.id)
  }

  const handleDisconnect = async (e, connectorId) => {
    e.stopPropagation()
    try {
      await api.disconnectProvider(connectorId)
      setConnections(prev => prev.filter(c => c.provider !== connectorId))
      if (isActive(connectorId)) onToggle(connectorId)
      onToast(`${connectorId} desconectado`)
    } catch (err) {
      onToast(`Error: ${err.message}`)
    }
  }

  return (
    <div className="connector-picker">
      <span className="connector-picker-label">Conectores</span>
      <div className="connector-chips">
        {CONNECTORS.map(conn => {
          const connected = isConnected(conn.id)
          const active = isActive(conn.id)
          const Icon = conn.icon
          return (
            <div
              key={conn.id}
              className={`connector-chip ${active ? 'active' : ''} ${connected ? 'connected' : ''}`}
              style={{ '--conn-color': conn.color, '--conn-color-light': conn.colorLight }}
              onClick={() => handleClick(conn)}
              title={connected ? (active ? 'Click para desactivar' : 'Click para activar') : 'Click para conectar'}
            >
              {loading === conn.id ? (
                <Loader2 size={14} className="connector-spin" />
              ) : (
                <Icon size={14} />
              )}
              <span>{conn.name}</span>
              {connected && <CheckCircle2 size={12} className="connector-check" />}
              {connected && (
                <button
                  className="connector-disconnect"
                  onClick={(e) => handleDisconnect(e, conn.id)}
                  title="Desconectar"
                >
                  <Unlink size={11} />
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
