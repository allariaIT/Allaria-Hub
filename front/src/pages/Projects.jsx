// front/src/pages/Projects.jsx
import { useState, useEffect } from 'react'
import { ExternalLink, Trash2, GitBranch, Square, Loader2 } from 'lucide-react'
import { api } from '../lib/api'
import { useNavigate } from 'react-router-dom'
import './Projects.css'

const STATUS_COLORS = {
  running: '#22c55e',
  stopped: '#ef4444',
  creating: '#eab308',
  error: '#ef4444',
}

export default function Projects() {
  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)
  const navigate = useNavigate()

  useEffect(() => {
    api.getProjects()
      .then(setProjects)
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [])

  const handleDelete = async (id) => {
    if (!confirm('Eliminar este proyecto? Se borrara el container, el repo y los archivos.')) return
    try {
      await api.deleteProject(id)
      setProjects(prev => prev.filter(p => p.id !== id))
    } catch (err) {
      alert('Error: ' + err.message)
    }
  }

  const handleStop = async (id) => {
    try {
      await api.stopProject(id)
      setProjects(prev => prev.map(p =>
        p.id === id ? { ...p, status: 'stopped' } : p
      ))
    } catch (err) {
      alert('Error: ' + err.message)
    }
  }

  if (loading) {
    return (
      <div className="projects-page">
        <div className="projects-loading">
          <Loader2 size={24} className="spin" />
        </div>
      </div>
    )
  }

  return (
    <div className="projects-page">
      <div className="projects-header">
        <h1>Mis Proyectos</h1>
        <p>Proyectos creados desde el chat con Sandbox</p>
      </div>

      {projects.length === 0 ? (
        <div className="projects-empty">
          <p>No tenes proyectos todavia.</p>
          <p>Activa el conector <strong>Sandbox</strong> en el chat y pedi que te cree uno.</p>
          <button className="btn btn-primary" onClick={() => navigate('/chat')}>
            Ir al Chat
          </button>
        </div>
      ) : (
        <div className="projects-grid">
          {projects.map(project => (
            <div key={project.id} className="project-card">
              <div className="project-card-header">
                <h3>{project.title}</h3>
                <span
                  className="project-status-badge"
                  style={{ '--status-color': STATUS_COLORS[project.status] || '#888' }}
                >
                  {project.status}
                </span>
              </div>

              {project.description && (
                <p className="project-card-desc">{project.description}</p>
              )}

              <div className="project-card-meta">
                <span className="project-card-slug">{project.name}</span>
                <span className="project-card-template">{project.template}</span>
              </div>

              <div className="project-card-actions">
                {project.previewUrl && (
                  <a
                    href={project.previewUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="project-btn preview"
                  >
                    <ExternalLink size={14} />
                    Preview
                  </a>
                )}
                {project.repoUrl && (
                  <a
                    href={project.repoUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="project-btn repo"
                  >
                    <GitBranch size={14} />
                    GitLab
                  </a>
                )}
                {project.status === 'running' && (
                  <button
                    className="project-btn stop"
                    onClick={() => handleStop(project.id)}
                  >
                    <Square size={14} />
                    Detener
                  </button>
                )}
                <button
                  className="project-btn delete"
                  onClick={() => handleDelete(project.id)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
