import { useEffect, useRef } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import './Login.css'

export default function Login() {
  const { user, isLoading, signIn } = useAuth()
  const googleBtnRef = useRef(null)

  useEffect(() => {
    if (isLoading || user) return
    // Render the Google Sign-In button
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

        <p className="login-footer">
          Tus conversaciones y datos se guardan asociados a tu cuenta.
        </p>
      </div>
    </div>
  )
}
