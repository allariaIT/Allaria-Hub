import Docker from 'dockerode'

const docker = new Docker()

export function containerName(userSlug, projectName) {
  return `sandbox-${userSlug}-${projectName}`
}

export function imageName(userSlug, projectName) {
  return `sandbox-${userSlug}-${projectName}:latest`
}

// Puertos reservados por builds en curso (previene race condition)
const reservedPorts = new Set()

export function findFreePort(usedPorts, rangeStart, rangeEnd) {
  for (let port = rangeStart; port <= rangeEnd; port++) {
    if (!usedPorts.has(port) && !reservedPorts.has(port)) {
      reservedPorts.add(port)
      return port
    }
  }
  throw new Error('No hay puertos disponibles en el rango')
}

export function releaseReservedPort(port) {
  reservedPorts.delete(port)
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

// Eliminar imágenes dangling (sin tag) para liberar disco.
// Llamar DESPUÉS de runContainer, cuando el container viejo ya fue detenido.
export async function pruneOldImage(tag) {
  try {
    // Buscar imágenes sin tag (dangling) que tengan el mismo repositorio base
    const images = await docker.listImages({ filters: { dangling: ['true'] } })
    for (const img of images) {
      try { await docker.getImage(img.Id).remove({ force: true }) } catch {}
    }
  } catch {}
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
    let remainder = Buffer.alloc(0)
    stream.on('data', (chunk) => {
      // Combinar con bytes residuales del chunk anterior
      const buf = Buffer.concat([remainder, chunk])
      let offset = 0
      while (offset + 8 <= buf.length) {
        const frameSize = buf.readUInt32BE(offset + 4)
        const end = offset + 8 + frameSize
        if (end > buf.length) break // frame incompleto, guardar para el próximo chunk
        output += buf.slice(offset + 8, end).toString()
        offset = end
      }
      remainder = buf.slice(offset) // guardar bytes sobrantes
    })
    stream.on('end', () => resolve(output))
    stream.on('error', reject)
  })
}
