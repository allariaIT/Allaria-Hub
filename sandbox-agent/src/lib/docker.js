import Docker from 'dockerode'

const docker = new Docker()

export function containerName(userSlug, projectName) {
  return `sandbox-${userSlug}-${projectName}`
}

export function imageName(userSlug, projectName) {
  return `sandbox-${userSlug}-${projectName}:latest`
}

export function findFreePort(usedPorts, rangeStart, rangeEnd) {
  for (let port = rangeStart; port <= rangeEnd; port++) {
    if (!usedPorts.has(port)) return port
  }
  throw new Error('No hay puertos disponibles en el rango')
}

export async function getUsedPorts() {
  const containers = await docker.listContainers({ all: true })
  const used = new Set()
  for (const c of containers) {
    if (c.Names.some(n => n.startsWith('/sandbox-'))) {
      for (const p of (c.Ports || [])) {
        if (p.PublicPort) used.add(p.PublicPort)
      }
    }
  }
  return used
}

export async function buildImage(contextDir, tag) {
  const stream = await docker.buildImage(
    { context: contextDir, src: ['.'] },
    { t: tag }
  )
  await new Promise((resolve, reject) => {
    docker.modem.followProgress(stream, (err, output) => {
      if (err) reject(err)
      else resolve(output)
    })
  })
}

export async function runContainer(name, imageTag, hostPort) {
  // Remove existing container if any
  try {
    const existing = docker.getContainer(name)
    await existing.stop().catch(() => {})
    await existing.remove()
  } catch {
    // Container doesn't exist, fine
  }

  const container = await docker.createContainer({
    Image: imageTag,
    name,
    HostConfig: {
      PortBindings: { '80/tcp': [{ HostPort: String(hostPort) }] },
      RestartPolicy: { Name: 'unless-stopped' },
    },
    ExposedPorts: { '80/tcp': {} },
  })
  await container.start()
  return container
}

export async function stopContainer(name) {
  try {
    const container = docker.getContainer(name)
    await container.stop()
    await container.remove()
  } catch {
    // Already stopped/removed
  }
}

export async function getContainerStatus(name) {
  try {
    const container = docker.getContainer(name)
    const info = await container.inspect()
    return info.State.Running ? 'running' : 'stopped'
  } catch {
    return 'stopped'
  }
}

export async function execInContainer(name, cmd) {
  const container = docker.getContainer(name)
  const exec = await container.exec({
    Cmd: ['sh', '-c', cmd],
    AttachStdout: true,
    AttachStderr: true,
  })
  const stream = await exec.start()
  return new Promise((resolve, reject) => {
    let output = ''
    stream.on('data', (chunk) => { output += chunk.toString() })
    stream.on('end', () => resolve(output))
    stream.on('error', reject)
  })
}
