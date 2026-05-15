import { useEffect, useRef, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import './Login.css'

export default function Login() {
  const { user, isLoading, signIn, signInWithPassword } = useAuth()
  const googleBtnRef = useRef(null)
  const [showPasswordForm, setShowPasswordForm] = useState(false)
  const [password, setPassword] = useState('')
  const [passwordError, setPasswordError] = useState('')
  const [isPasswordLoading, setIsPasswordLoading] = useState(false)

  useEffect(() => {
    if (isLoading || user) return
    if (window.google && googleBtnRef.current) {
      window.google.accounts.id.renderButton(googleBtnRef.current, {
        type: 'standard',
        shape: 'rectangular',
        theme: 'outline',
        size: 'large',
        text: 'signin_with',
        logo_alignment: 'left',
        width: 300,
      })
    }
  }, [isLoading, user])

  const handlePasswordSubmit = async (e) => {
    e.preventDefault()
    setPasswordError('')
    setIsPasswordLoading(true)
    try {
      await signInWithPassword(password)
    } catch (err) {
      setPasswordError(err.message || 'Contraseña incorrecta')
    } finally {
      setIsPasswordLoading(false)
    }
  }

  if (user) return <Navigate to="/" replace />

  return (
    <div className="login-page">
      <div className="login-bg">
        <div className="login-bg-pattern" />
      </div>
      <div className="login-card">
        <img src="/assets/apple-icon.png" alt="Allaria" className="login-logo" />
        <h1 className="login-title">Allaria Hub IA</h1>
        <p className="login-subtitle">IA Corporate Platform</p>
        <p className="login-desc">
          Iniciá sesión con tu cuenta de Google para acceder a la plataforma.
        </p>

        <div className="login-google-btn" ref={googleBtnRef} />

        {isLoading && (
          <div className="login-loading">
            <div className="login-spinner" />
            <span>Cargando...</span>
          </div>
        )}

        <div className="login-divider">
          <span>o</span>
        </div>

        <button
          className="login-alt-btn"
          onClick={() => { setShowPasswordForm(v => !v); setPasswordError('') }}
          type="button"
        >
          Otros métodos {showPasswordForm ? '▲' : '▼'}
        </button>

        {showPasswordForm && (
          <form className="login-password-form" onSubmit={handlePasswordSubmit}>
            <input
              className="login-password-input"
              type="password"
              placeholder="Contraseña"
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoFocus
              disabled={isPasswordLoading}
            />
            {passwordError && (
              <p className="login-password-error">{passwordError}</p>
            )}
            <button
              className="login-password-submit"
              type="submit"
              disabled={isPasswordLoading || !password}
            >
              {isPasswordLoading ? 'Ingresando...' : 'Ingresar'}
            </button>
          </form>
        )}

        <p className="login-footer">
          Tus conversaciones y datos se guardan asociados a tu cuenta.
        </p>
      </div>
    </div>
  )
}
