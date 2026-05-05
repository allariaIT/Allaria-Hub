import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { MessageSquare, FolderKanban, BookOpen, ArrowRight, TrendingUp, Users, Rocket, Activity } from 'lucide-react'
import { api } from '../lib/api'
import './Home.css'

const STAT_CONFIG = [
  { key: 'activeProjects', label: 'Proyectos activos',  icon: Rocket,   format: v => v },
  { key: 'totalUsers',     label: 'Usuarios',            icon: Users,    format: v => v },
  { key: 'chatsThisMonth', label: 'Chats este mes',      icon: Activity, format: v => v },
  { key: 'totalMessages',  label: 'Mensajes totales',    icon: TrendingUp, format: v => v >= 1000 ? `${(v/1000).toFixed(1)}k` : v },
]

export default function Home() {
  const [stats, setStats] = useState(null)

  useEffect(() => {
    api.getStats().catch(() => null).then(setStats)
  }, [])

  return (
    <>
      {/* Hero */}
      <section className="home-hero diagonal-accent">
        <div className="hero-content">
          <div className="hero-badge">
            <span className="hero-badge-dot" />
            Hub Interno
          </div>
          <h1 className="hero-title">
            Bienvenido a<br />
            <span className="hero-highlight">Allaria Hub IA</span>
          </h1>
          <p className="hero-subtitle">
            Tu plataforma centralizada de desarrollo. Proyectos, documentación, y un asistente IA
            para potenciar tu productividad.
          </p>
          <div className="hero-actions">
            <Link to="/chat" className="btn btn-gold">
              <MessageSquare size={16} />
              Iniciar Chat IA
            </Link>
            <Link to="/proyectos" className="btn btn-outline">
              Explorar Proyectos
              <ArrowRight size={16} />
            </Link>
          </div>
        </div>
        <div className="hero-visual">
          <div className="hero-logo-container">
            <img src="/assets/Logo.jpg" alt="Allaria" className="hero-logo" />
            <div className="hero-logo-ring" />
            <div className="hero-logo-ring ring-2" />
          </div>
        </div>
      </section>

      {/* Stats */}
      <section className="home-stats">
        {STAT_CONFIG.map((cfg, i) => {
          const Icon = cfg.icon
          const value = stats ? cfg.format(stats[cfg.key]) : '—'
          return (
            <div key={cfg.label} className="stat-card" style={{ animationDelay: `${i * 80}ms` }}>
              <div className="stat-icon"><Icon size={20} /></div>
              <div className="stat-value">{value}</div>
              <div className="stat-label">{cfg.label}</div>
            </div>
          )
        })}
      </section>

      {/* Quick Access */}
      <section className="home-quickaccess">
        <h2 className="section-title">Acceso Rápido</h2>
        <div className="quickaccess-grid">
          <Link to="/chat" className="quickaccess-card qa-chat">
            <div className="qa-icon">
              <MessageSquare size={24} />
            </div>
            <h3>Chat IA</h3>
            <p>Consultá al asistente impulsado por Gemini, ChatGPT y Claude para resolver dudas técnicas, generar código o analizar datos.</p>
            <span className="qa-link">
              Abrir chat <ArrowRight size={14} />
            </span>
          </Link>

          <Link to="/proyectos" className="quickaccess-card qa-projects">
            <div className="qa-icon">
              <FolderKanban size={24} />
            </div>
            <h3>Hub de Proyectos</h3>
            <p>Explorá todos los proyectos del equipo. Título, autor, descripción y estado de cada uno.</p>
            <span className="qa-link">
              Ver proyectos <ArrowRight size={14} />
            </span>
          </Link>

          <Link to="/docs" className="quickaccess-card qa-docs">
            <div className="qa-icon">
              <BookOpen size={24} />
            </div>
            <h3>Documentación</h3>
            <p>Guías, arquitectura, APIs y todo lo que necesitás para contribuir y entender el stack.</p>
            <span className="qa-link">
              Leer docs <ArrowRight size={14} />
            </span>
          </Link>
        </div>
      </section>
    </>
  )
}
