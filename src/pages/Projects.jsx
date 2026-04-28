import { useState } from 'react'
import { Search, Star, Calendar, ArrowUpRight } from 'lucide-react'
import { projects } from '../data/mockData'
import './Projects.css'

const statusColors = {
  'Producción': 'tag-green',
  'En desarrollo': 'tag-navy',
  'Beta': 'tag-gold',
}

export default function Projects() {
  const [search, setSearch] = useState('')
  const [filterStatus, setFilterStatus] = useState('Todos')

  const statuses = ['Todos', ...new Set(projects.map(p => p.status))]

  const filtered = projects.filter(p => {
    const matchSearch =
      p.title.toLowerCase().includes(search.toLowerCase()) ||
      p.author.toLowerCase().includes(search.toLowerCase()) ||
      p.description.toLowerCase().includes(search.toLowerCase()) ||
      p.tags.some(t => t.toLowerCase().includes(search.toLowerCase()))
    const matchStatus = filterStatus === 'Todos' || p.status === filterStatus
    return matchSearch && matchStatus
  })

  return (
    <>
      <div className="page-header">
        <div className="page-header-row">
          <div>
            <h2>Hub de Proyectos</h2>
            <p>Todos los proyectos del equipo de desarrollo</p>
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
              placeholder="Buscar por título, autor, tecnología..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="filter-pills">
            {statuses.map(s => (
              <button
                key={s}
                className={`filter-pill ${filterStatus === s ? 'active' : ''}`}
                onClick={() => setFilterStatus(s)}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="page-content">
        <div className="projects-grid">
          {filtered.map((project, i) => (
            <div
              key={project.id}
              className="project-card"
              style={{ animationDelay: `${i * 60}ms` }}
            >
              <div className="project-card-header">
                <div className="project-avatar">{project.avatar}</div>
                <div className="project-meta">
                  <h3>{project.title}</h3>
                  <span className="project-author">{project.author}</span>
                </div>
                <button className="project-open" title="Abrir proyecto">
                  <ArrowUpRight size={16} />
                </button>
              </div>

              <p className="project-desc">{project.description}</p>

              <div className="project-tags">
                {project.tags.map(tag => (
                  <span key={tag} className="project-tag">{tag}</span>
                ))}
              </div>

              <div className="project-footer">
                <span className={`tag ${statusColors[project.status] || 'tag-navy'}`}>
                  {project.status}
                </span>
                <div className="project-stats">
                  <span className="project-stat">
                    <Star size={13} />
                    {project.stars}
                  </span>
                  <span className="project-stat">
                    <Calendar size={13} />
                    {project.updatedAt}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>

        {filtered.length === 0 && (
          <div className="empty-state">
            <Search size={40} />
            <h3>Sin resultados</h3>
            <p>No se encontraron proyectos con esos criterios.</p>
          </div>
        )}
      </div>
    </>
  )
}
