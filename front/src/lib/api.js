const API_URL = import.meta.env.VITE_API_URL || ''

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

export const api = {
  authGoogle: (credential) =>
    request('/api/auth/google', {
      method: 'POST',
      body: JSON.stringify({ credential }),
    }),

  authPassword: (password) =>
    request('/api/auth/password', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),

  getStats: () => request('/api/stats'),

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

  // Connectors
  getConnectors: () => request('/api/connectors'),

  connectProvider: (provider) =>
    request('/api/connectors/auth', {
      method: 'POST',
      body: JSON.stringify({ provider }),
    }),

  disconnectProvider: (provider) =>
    request(`/api/connectors/${provider}`, { method: 'DELETE' }),

  sendMessage: (chatId, model, messages, connectors = []) =>
    request('/api/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ chatId, model, messages, connectors }),
    }),

  confirmAction: (chatId, model, connectors, llmMessages, confirmations) =>
    request('/api/chat/confirm', {
      method: 'POST',
      body: JSON.stringify({ chatId, model, connectors, llmMessages, confirmations }),
    }),

  streamMessage: (chatId, model, messages, connectors = []) => {
    const token = getToken()
    return fetch(`${API_URL}/api/chat/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ chatId, model, messages, connectors }),
    })
  },

  // Projects
  getCommunityProjects: () => request('/api/projects/community'),
  getProjects: () => request('/api/projects'),
  getProject: (id) => request(`/api/projects/${id}`),
  createProject: (data) => request('/api/projects', { method: 'POST', body: JSON.stringify(data) }),
  updateProject: (id, data) => request(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteProject: (id) => request(`/api/projects/${id}`, { method: 'DELETE' }),
  stopProject: (id) => request(`/api/projects/${id}/stop`, { method: 'POST' }),
  getProjectChat: (id) => request(`/api/projects/${id}/chat`),
  publishProject: (id) => request(`/api/projects/${id}/publish`, { method: 'PATCH' }),
  unpublishProject: (id) => request(`/api/projects/${id}/unpublish`, { method: 'PATCH' }),
  starProject: (id) => request(`/api/projects/${id}/star`, { method: 'POST' }),
  unstarProject: (id) => request(`/api/projects/${id}/star`, { method: 'DELETE' }),
}
