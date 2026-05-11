import { spawn } from 'node:child_process'

// Helper: correr un comando docker CLI y devolver stdout
function runDockerCmd(args, ignoreError = false) {
  return new Promise((resolve, reject) => {
    const proc = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    proc.stdout.on('data', d => { stdout += d.toString() })
    proc.stderr.on('data', d => { stderr += d.toString() })
    proc.on('close', code => {
      if (code === 0 || ignoreError) resolve(stdout.trim())
      else reject(new Error(`docker ${args[0]} (exit ${code}): ${stderr.slice(-300)}`))
    })
    proc.on('error', err => {
      if (ignoreError) resolve('')
      else reject(err)
    })
  })
}

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
  // docker ps --filter name=sandbox- --format '{{.Ports}}'
  // Output: "0.0.0.0:4001->80/tcp, :::4001->80/tcp"
  const out = await runDockerCmd(['ps', '--filter', 'name=sandbox-', '--format', '{{.Ports}}'], true)
  const used = new Set()
  for (const line of out.split('\n')) {
    const matches = line.matchAll(/:(\d+)->80/g)
    for (const m of matches) {
      used.add(parseInt(m[1]))
    }
  }
  return used
}

function spawnBuild(contextDir, tag, noCache = false) {
  return new Promise((resolve, reject) => {
    const args = ['build', '-t', tag]
    if (noCache) args.push('--no-cache')
    args.push('.')
    const proc = spawn('docker', args, { cwd: contextDir, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    proc.stderr.on('data', d => { stderr += d.toString() })
    proc.stdout.on('data', () => {})
    proc.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(`docker build falló (${code}): ${stderr.slice(-500)}`))
    })
    proc.on('error', err => reject(new Error(`spawn docker build: ${err.message}`)))
  })
}

export async function buildImage(contextDir, tag) {
  try {
    await spawnBuild(contextDir, tag)
  } catch (err) {
    // Error de containerd por builds concurrentes que comparten layers — retry sin cache
    if (err.message.includes('CreateDiff') || err.message.includes('mount callback') || err.message.includes('failed to commit')) {
      console.warn(`[buildImage] containerd layer error, reintentando con --no-cache...`)
      await spawnBuild(contextDir, tag, true)
    } else {
      throw err
    }
  }
}

export async function runContainer(name, imageTag, hostPort) {
  // Detener y eliminar container existente
  await runDockerCmd(['stop', name], true)
  await runDockerCmd(['rm', name], true)

  // Crear y arrancar nuevo container
  await runDockerCmd([
    'run', '-d',
    '--name', name,
    '-p', `${hostPort}:80`,
    '--restart', 'unless-stopped',
    imageTag,
  ])
}

export async function stopContainer(name) {
  await runDockerCmd(['stop', name], true)
  await runDockerCmd(['rm', name], true)
}

export async function getContainerStatus(name) {
  try {
    const out = await runDockerCmd(['inspect', '--format', '{{.State.Running}}', name])
    return out.trim() === 'true' ? 'running' : 'stopped'
  } catch {
    return 'stopped'
  }
}

// Eliminar imágenes dangling para liberar disco (llamar después de runContainer)
export async function pruneOldImage() {
  await runDockerCmd(['image', 'prune', '-f'], true)
}

export async function execInContainer(name, cmd) {
  // Docker CLI exec — sin necesidad de demultiplexar stream
  return runDockerCmd(['exec', name, 'sh', '-c', cmd], false)
}
