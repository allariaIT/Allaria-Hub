import fs from 'node:fs'
import Docker from 'dockerode'

const docker = new Docker()
const PROXY_HOST = process.env.PROXY_HOST || 'host.docker.internal'

export function generateNginxConfig(projects) {
  const locations = projects.map(p =>
    `    location /${p.userSlug}/${p.name}/ {
        proxy_pass http://${PROXY_HOST}:${p.port}/;
    }`
  ).join('\n\n')

  return `server {
    listen 3099;

${locations}
}
`
}

export async function writeAndReloadNginx(configPath, projects) {
  const config = generateNginxConfig(projects)
  fs.writeFileSync(configPath, config)
  try {
    const container = docker.getContainer('sandbox-nginx')
    const exec = await container.exec({
      Cmd: ['nginx', '-s', 'reload'],
      AttachStdout: true,
      AttachStderr: true,
    })
    const stream = await exec.start({})
    await new Promise(resolve => stream.on('end', resolve))
  } catch (err) {
    console.warn('[nginx] Could not reload:', err.message)
  }
}
