import { useState, useEffect } from 'react'
import { Loader2, X, Plug } from 'lucide-react'
import { api } from '../lib/api'
import './ConnectorPicker.css'

const CONNECTORS = [
  {
    id: 'gmail',
    name: 'Gmail',
    logo: 'https://www.google.com/s2/favicons?sz=64&domain=mail.google.com',
    color: '#EA4335',
    desc: 'Leer, buscar y enviar emails',
  },
  {
    id: 'calendar',
    name: 'Calendar',
    logo: 'https://www.google.com/s2/favicons?sz=64&domain=calendar.google.com',
    color: '#4285F4',
    desc: 'Ver, crear y buscar eventos',
  },
  {
    id: 'tasks',
    name: 'Tasks',
    logo: 'https://www.google.com/s2/favicons?sz=64&domain=tasks.google.com',
    color: '#1A73E8',
    desc: 'Listar, crear y completar tareas',
  },
  {
    id: 'drive',
    name: 'Drive',
    logo: 'https://www.google.com/s2/favicons?sz=64&domain=drive.google.com',
    color: '#0F9D58',
    desc: 'Buscar y ver archivos',
  },
  {
    id: 'sandbox',
    name: 'Sandbox',
    logo: 'https://www.google.com/s2/favicons?sz=64&domain=docker.com',
    color: '#2496ED',
    desc: 'Crear y editar proyectos web',
    noOAuth: true,
  },
]

export default function ConnectorPicker({ activeConnectors, onToggle, onToast }) {
  const [connections, setConnections] = useState([])
  const [loading, setLoading] = useState(null)
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    api.getConnectors().then(setConnections).catch(() => {})
  }, [])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const connected = params.get('connected')
    if (connected) {
      window.history.replaceState({}, '', '/chat')
      api.getConnectors().then(data => {
        setConnections(data)
        onToggle(connected)
        onToast(`${connected} conectado y activado`)
      })
    }
  }, [onToast])

  const isConnected = (id) => id === 'sandbox' || connections.some(c => c.provider === id)
  const isActive = (id) => activeConnectors.includes(id)

  const handleConnect = async (connector) => {
    setLoading(connector.id)
    try {
      const { url } = await api.connectProvider(connector.id)
      window.location.href = url
    } catch (err) {
      onToast(`Error al conectar: ${err.message}`)
      setLoading(null)
    }
  }

  const handleDisconnect = async (connectorId) => {
    try {
      await api.disconnectProvider(connectorId)
      setConnections(prev => prev.filter(c => c.provider !== connectorId))
      if (isActive(connectorId)) onToggle(connectorId)
      onToast(`${connectorId} desconectado`)
    } catch (err) {
      onToast(`Error: ${err.message}`)
    }
  }

  const hasActiveConnectors = activeConnectors.length > 0

  return (
    <div className="connector-wrapper">
      {/* Active connector badges - shown inline */}
      {CONNECTORS.filter(c => isActive(c.id)).map(conn => (
        <div
          key={conn.id}
          className="connector-active-badge"
          style={{ '--badge-color': conn.color }}
          onClick={() => onToggle(conn.id)}
        >
          <img src={conn.logo} alt={conn.name} className="connector-badge-logo" />
          <span>{conn.name}</span>
          <div className="connector-badge-dot" />
        </div>
      ))}

      {/* Menu trigger */}
      <div className="connector-menu-wrapper">
        <button
          className={`connector-trigger ${menuOpen ? 'open' : ''} ${hasActiveConnectors ? 'has-active' : ''}`}
          onClick={() => setMenuOpen(!menuOpen)}
          title="Conectores"
        >
          <Plug size={15} />
        </button>

        {menuOpen && (
          <>
            <div className="connector-backdrop" onClick={() => setMenuOpen(false)} />
            <div className="connector-menu">
              <div className="connector-menu-header">
                <span>Conectores</span>
                <button className="connector-menu-close" onClick={() => setMenuOpen(false)}>
                  <X size={14} />
                </button>
              </div>

              {CONNECTORS.map(conn => {
                const connected = isConnected(conn.id)
                const active = isActive(conn.id)

                return (
                  <div key={conn.id} className="connector-item">
                    <div className="connector-item-left">
                      <img src={conn.logo} alt={conn.name} className="connector-item-logo" />
                      <div className="connector-item-info">
                        <span className="connector-item-name">{conn.name}</span>
                        <span className="connector-item-desc">{conn.desc}</span>
                      </div>
                    </div>

                    <div className="connector-item-actions">
                      {loading === conn.id ? (
                        <div className="connector-item-loading">
                          <Loader2 size={16} className="connector-spin" />
                        </div>
                      ) : !connected ? (
                        <button
                          className="connector-btn-connect"
                          onClick={() => handleConnect(conn)}
                        >
                          Conectar
                        </button>
                      ) : (
                        <>
                          <button
                            className={`connector-toggle ${active ? 'on' : ''}`}
                            onClick={() => onToggle(conn.id)}
                            title={active ? 'Desactivar' : 'Activar'}
                          >
                            <div className="connector-toggle-track">
                              <div className="connector-toggle-thumb" />
                            </div>
                          </button>
                          {!conn.noOAuth && (
                            <button
                              className="connector-btn-disconnect"
                              onClick={() => handleDisconnect(conn.id)}
                              title="Desconectar cuenta"
                            >
                              Desconectar
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
