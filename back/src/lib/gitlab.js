// back/src/lib/gitlab.js
const GITLAB_URL = process.env.GITLAB_URL || 'https://gitlab.allaria.xyz'
const GITLAB_TOKEN = process.env.GITLAB_TOKEN
const GITLAB_GROUP_ID = process.env.GITLAB_GROUP_ID || '54'

async function gitlabApi(path, options = {}) {
  const res = await fetch(`${GITLAB_URL}/api/v4${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'PRIVATE-TOKEN': GITLAB_TOKEN,
      ...options.headers,
    },
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.message || JSON.stringify(data))
  return data
}

export async function createGitlabRepo(userSlug, projectName) {
  const repoName = `${userSlug}-${projectName}`
  const data = await gitlabApi('/projects', {
    method: 'POST',
    body: JSON.stringify({
      name: repoName,
      namespace_id: parseInt(GITLAB_GROUP_ID),
      visibility: 'internal',
      initialize_with_readme: false,
    }),
  })
  return {
    gitlabId: data.id,
    repoUrl: data.http_url_to_repo,
    webUrl: data.web_url,
  }
}

export async function deleteGitlabRepo(gitlabId) {
  await gitlabApi(`/projects/${gitlabId}`, { method: 'DELETE' })
}
