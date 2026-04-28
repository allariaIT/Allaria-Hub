import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { api, setToken, clearToken } from '../lib/api'

const AuthContext = createContext(null)

// ⚠️ Reemplazá con tu Client ID de Google Cloud Console
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

  const handleCredentialResponse = useCallback(async (response) => {
    try {
      // Verificar token en el backend y crear/actualizar usuario
      const data = await api.authGoogle(response.credential)
      const userData = data.user
      setToken(data.token)
      localStorage.setItem('allaria_user', JSON.stringify(userData))
      setUser(userData)
    } catch (err) {
      console.error('Auth error:', err)
      // Fallback: decode locally if backend is down
      const payload = JSON.parse(atob(response.credential.split('.')[1]))
      const userData = {
        id: payload.sub,
        name: payload.name,
        email: payload.email,
        picture: payload.picture,
      }
      setToken(response.credential)
      localStorage.setItem('allaria_user', JSON.stringify(userData))
      setUser(userData)
    }
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
    clearToken()
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
