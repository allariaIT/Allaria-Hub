import { createContext, useContext, useState, useEffect, useCallback } from 'react'

const AuthContext = createContext(null)

// ⚠️ Reemplazá esto con tu Client ID de Google Cloud Console
// Crealo en: https://console.cloud.google.com/apis/credentials
// Tipo: OAuth 2.0 Client ID > Web application
// Authorized JavaScript origins: http://localhost:5174 (dev) + tu dominio (prod)
const GOOGLE_CLIENT_ID = 'TU_GOOGLE_CLIENT_ID.apps.googleusercontent.com'

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    try {
      const saved = localStorage.getItem('allaria_user')
      return saved ? JSON.parse(saved) : null
    } catch {
      return null
    }
  })
  const [isLoading, setIsLoading] = useState(true)

  const handleCredentialResponse = useCallback((response) => {
    // Decode JWT token from Google
    const payload = JSON.parse(atob(response.credential.split('.')[1]))
    const userData = {
      id: payload.sub,
      name: payload.name,
      email: payload.email,
      picture: payload.picture,
    }
    localStorage.setItem('allaria_user', JSON.stringify(userData))
    setUser(userData)
  }, [])

  useEffect(() => {
    const script = document.createElement('script')
    script.src = 'https://accounts.google.com/gsi/client'
    script.async = true
    script.defer = true
    script.onload = () => {
      window.google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: handleCredentialResponse,
        auto_select: true,
      })
      setIsLoading(false)
    }
    script.onerror = () => {
      setIsLoading(false)
    }
    document.head.appendChild(script)

    return () => {
      document.head.removeChild(script)
    }
  }, [handleCredentialResponse])

  const signIn = useCallback(() => {
    if (window.google) {
      window.google.accounts.id.prompt()
    }
  }, [])

  const signOut = useCallback(() => {
    if (window.google) {
      window.google.accounts.id.disableAutoSelect()
    }
    localStorage.removeItem('allaria_user')
    setUser(null)
  }, [])

  return (
    <AuthContext.Provider value={{ user, isLoading, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
