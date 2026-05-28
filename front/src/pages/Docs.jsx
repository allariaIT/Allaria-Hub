import { useState } from 'react'
import { ChevronRight, Clock, Search, BookMarked, ArrowLeft } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import { docSections } from '../data/mockData'
import './Docs.css'

export default function Docs() {
  const [search, setSearch] = useState('')
  const [expandedSection, setExpandedSection] = useState('getting-started')
  const [selectedArticle, setSelectedArticle] = useState(null)

  const filtered = search.trim()
    ? docSections.map(s => ({
        ...s,
        articles: s.articles.filter(a =>
          a.title.toLowerCase().includes(search.toLowerCase())
        ),
      })).filter(s => s.articles.length > 0)
    : docSections

  function handleArticleClick(article, section) {
    setSelectedArticle({ ...article, sectionTitle: section.title })
  }

  function handleBack() {
    setSelectedArticle(null)
  }

  function handleSectionClick(sectionId) {
    setExpandedSection(sectionId)
    setSelectedArticle(null)
  }

  return (
    <>
      <div className="page-header">
        <div className="page-header-row">
          <div>
            <h2>Documentación</h2>
            <p>Guías, referencias y todo lo que necesitás saber</p>
          </div>
        </div>

        {!selectedArticle && (
          <div className="docs-search-bar">
            <Search size={16} />
            <input
              type="text"
              placeholder="Buscar en la documentación..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        )}
      </div>

      <div className="page-content">
        <div className="docs-layout">
          <aside className="docs-sidebar">
            <div className="docs-sidebar-title">
              <BookMarked size={16} />
              Secciones
            </div>
            {docSections.map(section => (
              <button
                key={section.id}
                className={`docs-nav-item ${expandedSection === section.id ? 'active' : ''}`}
                onClick={() => handleSectionClick(section.id)}
              >
                <span className="docs-nav-icon">{section.icon}</span>
                {section.title}
                <ChevronRight size={14} className="docs-nav-arrow" />
              </button>
            ))}
          </aside>

          <div className="docs-main">
            {selectedArticle ? (
              <div className="docs-article-view">
                <button className="docs-back-btn" onClick={handleBack}>
                  <ArrowLeft size={15} />
                  Volver a {selectedArticle.sectionTitle}
                </button>
                <div className="docs-article-header">
                  <h2>{selectedArticle.title}</h2>
                  <span className="docs-article-time">
                    <Clock size={12} />
                    {selectedArticle.readTime}
                  </span>
                </div>
                <div className="docs-article-body">
                  <ReactMarkdown>{selectedArticle.content}</ReactMarkdown>
                </div>
              </div>
            ) : filtered.length === 0 ? (
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
                        onClick={() => handleArticleClick(article, section)}
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
