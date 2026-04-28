const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3098'

function getToken() {
  return localStorage.getItem('allaria_token')
}

export function setToken(token) {
  localStorage.setItem('allaria_token', token)
}

export function clearToken() {
  localStorage.removeItem('allaria_token')
}

async function request(path, options = {}) {
  const token = getToken()
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'Error del servidor')
  return data
}

// Auth
export const api = {
  authGoogle: (credential) =>
    request('/api/auth/google', {
      method: 'POST',
      body: JSON.stringify({ credential }),
    }),

  // Chats
  getChats: () => request('/api/chats'),

  createChat: (title) =>
    request('/api/chats', {
      method: 'POST',
      body: JSON.stringify({ title }),
    }),

  updateChat: (id, title) =>
    request(`/api/chats/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }),

  deleteChat: (id) =>
    request(`/api/chats/${id}`, { method: 'DELETE' }),

  clearChat: (id) =>
    request(`/api/chats/${id}/messages`, { method: 'DELETE' }),

  // Chat completions (proxy)
  sendMessage: (chatId, model, messages) =>
    request('/api/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ chatId, model, messages }),
    }),
}
