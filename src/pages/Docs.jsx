import { useState } from 'react'
import { ChevronRight, Clock, Search, BookMarked } from 'lucide-react'
import { docSections } from '../data/mockData'
import './Docs.css'

export default function Docs() {
  const [search, setSearch] = useState('')
  const [expandedSection, setExpandedSection] = useState('getting-started')

  const filtered = search.trim()
    ? docSections.map(s => ({
        ...s,
        articles: s.articles.filter(a =>
          a.title.toLowerCase().includes(search.toLowerCase())
        ),
      })).filter(s => s.articles.length > 0)
    : docSections

  return (
    <>
      <div className="page-header">
        <div className="page-header-row">
          <div>
            <h2>Documentación</h2>
            <p>Guías, referencias y todo lo que necesitás saber</p>
          </div>
        </div>

        <div className="docs-search-bar">
          <Search size={16} />
          <input
            type="text"
            placeholder="Buscar en la documentación..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      <div className="page-content">
        <div className="docs-layout">
          {/* Sidebar nav */}
          <aside className="docs-sidebar">
            <div className="docs-sidebar-title">
              <BookMarked size={16} />
              Secciones
            </div>
            {docSections.map(section => (
              <button
                key={section.id}
                className={`docs-nav-item ${expandedSection === section.id ? 'active' : ''}`}
                onClick={() => setExpandedSection(section.id)}
              >
                <span className="docs-nav-icon">{section.icon}</span>
                {section.title}
                <ChevronRight size={14} className="docs-nav-arrow" />
              </button>
            ))}
          </aside>

          {/* Main content */}
          <div className="docs-main">
            {filtered.length === 0 ? (
              <div className="empty-state">
                <Search size={40} />
                <h3>Sin resultados</h3>
                <p>No se encontraron artículos con ese término.</p>
              </div>
            ) : (
              filtered.map(section => (
                <div
                  key={section.id}
                  className={`docs-section ${!search && expandedSection !== section.id ? 'hidden' : ''}`}
                >
                  <div className="docs-section-header">
                    <span className="docs-section-icon">{section.icon}</span>
                    <h3>{section.title}</h3>
                    <span className="docs-section-count">{section.articles.length} artículos</span>
                  </div>

                  <div className="docs-articles">
                    {section.articles.map((article, i) => (
                      <button
                        key={i}
                        className="docs-article"
                        style={{ animationDelay: `${i * 50}ms` }}
                      >
                        <div className="docs-article-info">
                          <h4>{article.title}</h4>
                          <span className="docs-article-time">
                            <Clock size={12} />
                            {article.readTime}
                          </span>
                        </div>
                        <ChevronRight size={16} className="docs-article-arrow" />
                      </button>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </>
  )
}
