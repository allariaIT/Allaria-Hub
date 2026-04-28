import { Link } from 'react-router-dom'
import { MessageSquare, FolderKanban, BookOpen, ArrowRight, TrendingUp, Users, Rocket, Activity } from 'lucide-react'
import { stats } from '../data/mockData'
import './Home.css'

const statIcons = [Rocket, Users, TrendingUp, Activity]

export default function Home() {
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
        {stats.map((stat, i) => {
          const Icon = statIcons[i]
          return (
            <div key={stat.label} className="stat-card" style={{ animationDelay: `${i * 80}ms` }}>
              <div className="stat-icon">
                <Icon size={20} />
              </div>
              <div className="stat-value">{stat.value}</div>
              <div className="stat-label">{stat.label}</div>
              <div className="stat-change">{stat.change}</div>
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
            <p>Consultá al asistente impulsado por Gemini para resolver dudas técnicas, generar código o analizar datos.</p>
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
