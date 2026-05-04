import fs from 'node:fs'
import { execSync } from 'node:child_process'

export function generateNginxConfig(projects) {
  const locations = projects.map(p =>
    `    location /${p.userSlug}/${p.name}/ {
        proxy_pass http://localhost:${p.port}/;
    }`
  ).join('\n\n')

  return `server {
    listen 3099;

${locations}
}
`
}

export function writeAndReloadNginx(configPath, projects) {
  const config = generateNginxConfig(projects)
  fs.writeFileSync(configPath, config)
  try {
    execSync('nginx -s reload', { stdio: 'ignore' })
  } catch {
    console.warn('[nginx] Could not reload — is nginx running?')
  }
}
