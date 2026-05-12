// back/src/lib/sandbox-client.js
const SANDBOX_AGENT_URL = process.env.SANDBOX_AGENT_URL || 'http://172.30.200.101:3100'
const SANDBOX_AGENT_KEY = process.env.SANDBOX_AGENT_KEY

async function sandboxRequest(path, options = {}, timeoutMs = 10_000) {
  const res = await fetch(`${SANDBOX_AGENT_URL}${path}`, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'Content-Type': 'application/json',
      'X-Sandbox-Key': SANDBOX_AGENT_KEY,
      ...options.headers,
    },
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'Sandbox agent error')
  return data
}

export async function sandboxCreateProject(userSlug, name, title, repoUrl) {
  return sandboxRequest('/projects', {
    method: 'POST',
    body: JSON.stringify({ userSlug, name, title, repoUrl }),
  })
}

export async function sandboxWriteFile(userSlug, name, filePath, content) {
  return sandboxRequest(`/projects/${userSlug}/${name}/files`, {
    method: 'POST',
    body: JSON.stringify({ path: filePath, content }),
  })
}

export async function sandboxReadFile(userSlug, name, filePath) {
  return sandboxRequest(`/projects/${userSlug}/${name}/files/${filePath}`)
}

export async function sandboxListFiles(userSlug, name) {
  return sandboxRequest(`/projects/${userSlug}/${name}/tree`)
}

export async function sandboxBuild(userSlug, name) {
  // Build es async ahora — el endpoint responde inmediatamente
  return sandboxRequest(`/projects/${userSlug}/${name}/build`, { method: 'POST' })
}

export async function sandboxPush(userSlug, name, message, repoUrl) {
  return sandboxRequest(`/projects/${userSlug}/${name}/push`, {
    method: 'POST',
    body: JSON.stringify({ message, repoUrl }),
  })
}

export async function sandboxStatus(userSlug, name) {
  return sandboxRequest(`/projects/${userSlug}/${name}`)
}

export async function sandboxDelete(userSlug, name) {
  return sandboxRequest(`/projects/${userSlug}/${name}`, { method: 'DELETE' })
}

export async function sandboxStop(userSlug, name) {
  return sandboxRequest(`/projects/${userSlug}/${name}/stop`, { method: 'POST' })
}
