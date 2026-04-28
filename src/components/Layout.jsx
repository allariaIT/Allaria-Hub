import { useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { Home, MessageSquare, FolderKanban, BookOpen, Menu, X, Sparkles, LogOut } from 'lucide-react'
import { useAuth } from '../context/AuthContext'

const navItems = [
  { to: '/', icon: Home, label: 'Inicio' },
  { to: '/chat', icon: MessageSquare, label: 'Chat IA' },
  { to: '/proyectos', icon: FolderKanban, label: 'Hub de Proyectos' },
  { to: '/docs', icon: BookOpen, label: 'Documentación' },
]

export default function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const { user, signOut } = useAuth()

  return (
    <div className="app-layout">
      <button
        className="mobile-menu-btn"
        onClick={() => setSidebarOpen(!sidebarOpen)}
        aria-label="Toggle menu"
      >
        {sidebarOpen ? <X size={20} /> : <Menu size={20} />}
      </button>

      <div
        className={`sidebar-overlay ${sidebarOpen ? 'visible' : ''}`}
        onClick={() => setSidebarOpen(false)}
      />

      <aside className={`app-sidebar ${sidebarOpen ? 'open' : ''}`}>
        <div className="sidebar-header">
          <div className="sidebar-brand">
            <img src="/assets/apple-icon.png" alt="Allaria" className="sidebar-logo" />
            <div className="sidebar-brand-text">
              <h1>Allaria Hub</h1>
              <span>IA Corporate Platform</span>
            </div>
          </div>
        </div>

        <nav className="sidebar-nav">
          <span className="sidebar-section-label">Principal</span>
          {navItems.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}
              onClick={() => setSidebarOpen(false)}
            >
              <Icon size={18} />
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="sidebar-footer-badge">
            <div className="dot" />
            <Sparkles size={14} />
            <span>Gemini 2.5 · LiteLLM</span>
          </div>

          {user && (
            <div className="sidebar-user">
              <img
                src={user.picture}
                alt={user.name}
                className="sidebar-user-avatar"
                referrerPolicy="no-referrer"
              />
              <div className="sidebar-user-info">
                <span className="sidebar-user-name">{user.name}</span>
                <span className="sidebar-user-email">{user.email}</span>
              </div>
              <button className="sidebar-user-logout" onClick={signOut} title="Cerrar sesión">
                <LogOut size={14} />
              </button>
            </div>
          )}
        </div>
      </aside>

      <main className="app-main">
        <Outlet />
      </main>
    </div>
  )
}
