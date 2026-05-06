import { useState, useEffect } from 'react'
import { Search, ArrowUpRight, Plus, Loader2, ExternalLink, GitBranch, Square, Trash2, X, Globe, EyeOff, Star } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { useAuth } from '../context/AuthContext'
import './Projects.css'

const STATUS_LABELS = { running: 'Activo', stopped: 'Detenido', creating: 'Creando...', error: 'Error' }
const STATUS_COLORS = { running: '#22c55e', stopped: '#888', creating: '#eab308', error: '#ef4444' }

export default function Projects() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [myProjects, setMyProjects] = useState([])
  const [communityProjects, setCommunityProjects] = useState([])
  const [loadingMy, setLoadingMy] = useState(true)
  const [loadingCommunity, setLoadingCommunity] = useState(true)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState('')
  const [form, setForm] = useState({ name: '', title: '', description: '' })

  // Hub filters
  const [search, setSearch] = useState('')

  useEffect(() => {
    api.getProjects()
      .then(setMyProjects)
      .catch(console.error)
      .finally(() => setLoadingMy(false))
    api.getCommunityProjects()
      .then(setCommunityProjects)
      .catch(console.error)
      .finally(() => setLoadingCommunity(false))
  }, [])

  // Polling: si hay proyectos en 'creating', refrescar cada 5s hasta que cambien
  useEffect(() => {
    const hasCreating = myProjects.some(p => p.status === 'creating')
    if (!hasCreating) return
    const interval = setInterval(() => {
      api.getProjects().then(fresh => {
        setMyProjects(fresh)
      }).catch(() => {})
    }, 5000)
    return () => clearInterval(interval)
  }, [myProjects])

  const filtered = communityProjects.filter(p => {
    if (!search) return true
    const q = search.toLowerCase()
    return (
      p.title.toLowerCase().includes(q) ||
      p.user?.name?.toLowerCase().includes(q) ||
      p.description?.toLowerCase().includes(q) ||
      p.name.toLowerCase().includes(q)
    )
  })

  const handleCreate = async (e) => {
    e.preventDefault()
    setCreating(true)
    setCreateError('')
    try {
      const project = await api.createProject(form)
      setMyProjects(prev => [project, ...prev])
      setShowCreateModal(false)
      setForm({ name: '', title: '', description: '' })
      if (project.status === 'running') {
        navigate(`/proyectos/${project.id}`)
      }
    } catch (err) {
      setCreateError(err.message)
    } finally {
      setCreating(false)
    }
  }

  const handleDelete = async (e, id) => {
    e.stopPropagation()
    if (!confirm('¿Eliminar este proyecto? Se borrará el container, el repo y los archivos.')) return
    try {
      await api.deleteProject(id)
      setMyProjects(prev => prev.filter(p => p.id !== id))
    } catch (err) {
      alert('Error: ' + err.message)
    }
  }

  const handleStop = async (e, id) => {
    e.stopPropagation()
    try {
      await api.stopProject(id)
      setMyProjects(prev => prev.map(p => p.id === id ? { ...p, status: 'stopped' } : p))
    } catch (err) {
      alert('Error: ' + err.message)
    }
  }

  const handlePublish = async (e, id) => {
    e.stopPropagation()
    try {
      const updated = await api.publishProject(id)
      setMyProjects(prev => prev.map(p => p.id === id ? { ...p, ...updated } : p))
    } catch (err) {
      alert('Error: ' + err.message)
    }
  }

  const handleUnpublish = async (e, id) => {
    e.stopPropagation()
    try {
      const updated = await api.unpublishProject(id)
      setMyProjects(prev => prev.map(p => p.id === id ? { ...p, ...updated } : p))
    } catch (err) {
      alert('Error: ' + err.message)
    }
  }

  const handleStar = async (project) => {
    const wasStarred = project.starredByMe
    // Optimistic update
    setCommunityProjects(prev => prev.map(p =>
      p.id === project.id
        ? { ...p, starredByMe: !wasStarred, _count: { ...p._count, stars: p._count.stars + (wasStarred ? -1 : 1) } }
        : p
    ))
    try {
      if (wasStarred) {
        await api.unstarProject(project.id)
      } else {
        await api.starProject(project.id)
      }
    } catch {
      // Revertir si falla
      setCommunityProjects(prev => prev.map(p =>
        p.id === project.id
          ? { ...p, starredByMe: wasStarred, _count: { ...p._count, stars: p._count.stars + (wasStarred ? 1 : -1) } }
          : p
      ))
    }
  }

  // Auto-generate name slug from title
  const handleTitleChange = (title) => {
    setForm(f => ({
      ...f,
      title,
      name: title.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .slice(0, 40),
    }))
  }

  return (
    <>
      {/* MIS PROYECTOS */}
      <div className="page-header">
        <div className="page-header-row">
          <div>
            <h2>Mis Proyectos</h2>
            <p>Proyectos web creados con el Sandbox de IA</p>
          </div>
          <button className="btn btn-primary" onClick={() => setShowCreateModal(true)}>
            <Plus size={16} />
            Crear Proyecto
          </button>
        </div>
      </div>

      <div className="page-content" style={{ paddingBottom: 0 }}>
        {loadingMy ? (
          <div className="my-projects-loading"><Loader2 size={20} className="spin-icon" /></div>
        ) : myProjects.length === 0 ? (
          <div className="my-projects-empty">
            <p>No tenés proyectos todavía. Creá uno con el botón de arriba.</p>
          </div>
        ) : (
          <div className="my-projects-grid">
            {myProjects.map(project => (
              <div
                key={project.id}
                className={`my-project-card ${project.status === 'error' || project.status === 'creating' ? 'my-project-card--disabled' : ''}`}
                onClick={() => project.status !== 'error' && project.status !== 'creating' && navigate(`/proyectos/${project.id}`)}
                title={project.status === 'creating' ? 'El proyecto se está creando...' : project.status === 'error' ? 'El proyecto tuvo un error al crearse' : undefined}
              >
                <div className="my-project-card-top">
                  <div className="my-project-avatar">{project.title.slice(0, 2).toUpperCase()}</div>
                  <div className="my-project-info">
                    <span className="my-project-title">{project.title}</span>
                    <span className="my-project-slug">{project.name}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    {(project.isPublic || project._count?.stars > 0) && (
                      <span className="my-project-stars">
                        <Star size={11} style={{ fill: '#eab308', color: '#eab308' }} />
                        {project._count?.stars ?? 0}
                      </span>
                    )}
                    <span
                      className="my-project-status"
                      style={{ '--sc': STATUS_COLORS[project.status] || '#888' }}
                    >
                      {project.status === 'creating' && <Loader2 size={11} className="spin-icon" style={{ marginRight: 4 }} />}
                      {STATUS_LABELS[project.status] || project.status}
                    </span>
                  </div>
                </div>
                {project.description && <p className="my-project-desc">{project.description}</p>}
                <div className="my-project-actions" onClick={e => e.stopPropagation()}>
                  {project.previewUrl && (
                    <a href={project.previewUrl} target="_blank" rel="noopener noreferrer" className="my-project-btn">
                      <ExternalLink size={13} /> Preview
                    </a>
                  )}
                  {project.repoUrl && (
                    <a href={project.repoUrl} target="_blank" rel="noopener noreferrer" className="my-project-btn">
                      <GitBranch size={13} /> GitLab
                    </a>
                  )}
                  {project.status === 'running' && (
                    project.isPublic
                      ? <button className="my-project-btn" onClick={(e) => handleUnpublish(e, project.id)} title="Despublicar">
                          <EyeOff size={13} /> Despublicar
                        </button>
                      : <button className="my-project-btn publish" onClick={(e) => handlePublish(e, project.id)} title="Publicar en el Hub">
                          <Globe size={13} /> Publicar
                        </button>
                  )}
                  {project.status === 'running' && (
                    <button className="my-project-btn stop" onClick={(e) => handleStop(e, project.id)}>
                      <Square size={13} /> Detener
                    </button>
                  )}
                  <button className="my-project-btn delete" onClick={(e) => handleDelete(e, project.id)}>
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* HUB DE PROYECTOS */}
      <div className="page-header" style={{ marginTop: '2rem' }}>
        <div className="page-header-row">
          <div>
            <h2>Hub de Proyectos</h2>
            <p>Proyectos creados por el equipo con Sandbox IA</p>
          </div>
          <div className="projects-count">
            <span className="count-number">{filtered.length}</span>
            <span className="count-label">proyectos</span>
          </div>
        </div>
        <div className="projects-toolbar">
          <div className="search-box">
            <Search size={16} />
            <input
              type="text"
              placeholder="Buscar por título, autor..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
      </div>

      <div className="page-content">
        {loadingCommunity ? (
          <div className="my-projects-loading"><Loader2 size={20} className="spin-icon" /></div>
        ) : (
          <>
            <div className="projects-grid">
              {filtered.map((project, i) => (
                <div
                  key={project.id}
                  className="project-card"
                  style={{ animationDelay: `${i * 60}ms`, cursor: project.previewUrl ? 'pointer' : 'default' }}
                  onClick={() => project.previewUrl && window.open(project.previewUrl, '_blank')}
                >
                  <div className="project-card-header">
                    <div className="project-avatar">{project.title.slice(0, 2).toUpperCase()}</div>
                    <div className="project-meta">
                      <h3>{project.title}</h3>
                      <span className="project-author">{project.user?.name || '—'}</span>
                    </div>
                    {project.previewUrl && (
                      <button className="project-open" title="Ver preview">
                        <ArrowUpRight size={16} />
                      </button>
                    )}
                  </div>
                  {project.description && <p className="project-desc">{project.description}</p>}
                  <div className="project-footer">
                    <span
                      className="my-project-status"
                      style={{ '--sc': STATUS_COLORS[project.status] || '#888' }}
                    >
                      {STATUS_LABELS[project.status] || project.status}
                    </span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span className="project-stat" style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>
                        {new Date(project.createdAt).toLocaleDateString('es-AR')}
                      </span>
                      {project.user?.id !== user?.id && (
                        <button
                          className={`star-btn${project.starredByMe ? ' star-btn--active' : ''}`}
                          onClick={(e) => { e.stopPropagation(); handleStar(project) }}
                          title={project.starredByMe ? 'Quitar estrella' : 'Dar estrella'}
                        >
                          <Star size={13} />
                          <span>{project._count?.stars ?? 0}</span>
                        </button>
                      )}
                      {project.user?.id === user?.id && project._count?.stars > 0 && (
                        <span className="star-count-own">
                          <Star size={13} style={{ fill: '#eab308', color: '#eab308' }} />
                          {project._count.stars}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            {filtered.length === 0 && (
              <div className="empty-state">
                <Search size={40} />
                <h3>{search ? 'Sin resultados' : 'Todavía no hay proyectos'}</h3>
                <p>{search ? 'No se encontraron proyectos con esos criterios.' : 'Sé el primero en crear uno.'}</p>
              </div>
            )}
          </>
        )}
      </div>

      {/* MODAL CREAR PROYECTO */}
      {showCreateModal && (
        <div className="modal-overlay" onClick={() => setShowCreateModal(false)}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Crear Proyecto</h3>
              <button className="modal-close" onClick={() => setShowCreateModal(false)}><X size={18} /></button>
            </div>
            <form onSubmit={handleCreate} className="modal-form">
              <label>
                <span>Título</span>
                <input
                  type="text"
                  placeholder="Mi Dashboard de Ventas"
                  value={form.title}
                  onChange={e => handleTitleChange(e.target.value)}
                  required
                  autoFocus
                />
              </label>
              <label>
                <span>Nombre del proyecto (slug)</span>
                <input
                  type="text"
                  placeholder="mi-dashboard-ventas"
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  required
                  pattern="[a-z0-9-]+"
                />
                <span className="modal-hint">Solo letras minúsculas, números y guiones</span>
              </label>
              <label>
                <span>Descripción (opcional)</span>
                <textarea
                  placeholder="Panel con métricas en tiempo real..."
                  value={form.description}
                  onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                  rows={3}
                />
              </label>
              {createError && <div className="modal-error">{createError}</div>}
              <div className="modal-actions">
                <button type="button" className="btn btn-ghost" onClick={() => setShowCreateModal(false)}>
                  Cancelar
                </button>
                <button type="submit" className="btn btn-primary" disabled={creating}>
                  {creating ? <><Loader2 size={14} className="spin-icon" /> Creando...</> : 'Crear Proyecto'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  )
}
