import fs from 'node:fs'
import { spawn } from 'node:child_process'

const PROXY_HOST = process.env.PROXY_HOST || 'host.docker.internal'

export function generateNginxConfig(projects) {
  const locations = projects.map(p =>
    `    location /${p.userSlug}/${p.name}/ {
        proxy_pass http://${PROXY_HOST}:${p.port}/;
    }`
  ).join('\n\n')

  return `server {
    listen 3099;

    location = / {
        return 200 'ok';
        add_header Content-Type text/plain;
    }

${locations}
}
`
}

export async function writeAndReloadNginx(configPath, projects) {
  const config = generateNginxConfig(projects)
  fs.writeFileSync(configPath, config)
  // Recargar nginx via CLI — dockerode.exec cuelga en este entorno
  await new Promise((resolve) => {
    const proc = spawn('docker', ['exec', 'sandbox-nginx', 'nginx', '-s', 'reload'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    proc.stdout.on('data', () => {})
    proc.stderr.on('data', () => {})
    proc.on('close', () => resolve())
    proc.on('error', () => resolve()) // ignorar errores — nginx sigue funcionando con config anterior
  })
}
