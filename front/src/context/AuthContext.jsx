import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { api, setToken, clearToken } from '../lib/api'

const AuthContext = createContext(null)

const GOOGLE_CLIENT_ID = '789748745254-3tfsnd7h5r5k2nl2plqjq91o2f4s5rq5.apps.googleusercontent.com'

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
      const data = await api.authGoogle(response.credential)
      setToken(data.token)
      localStorage.setItem('allaria_user', JSON.stringify(data.user))
      setUser(data.user)
    } catch (err) {
      console.error('Auth error:', err)
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
