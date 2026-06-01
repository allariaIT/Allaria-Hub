import k8s from '@kubernetes/client-node'

const NAMESPACE = 'user-projects'
const CONFIGMAP_NAME = 'router-config'
const DEPLOYMENT_NAME = 'user-projects-router'

function makeClients() {
  const kc = new k8s.KubeConfig()
  if (process.env.KUBERNETES_SERVICE_HOST) {
    kc.loadFromCluster()
  } else {
    kc.loadFromDefault()
  }
  return {
    core: kc.makeApiClient(k8s.CoreV1Api),
    apps: kc.makeApiClient(k8s.AppsV1Api),
  }
}

function serviceNameFor(userSlug, name) {
  return `${userSlug}-${name}`.slice(0, 63)
}

async function resolveServiceName(userSlug, name) {
  const { core } = makeClients()
  const full = `${userSlug}-${name}`

  // Fast path: exact name or 63-char truncation
  for (const candidate of [...new Set([full, full.slice(0, 63)])]) {
    try {
      await core.readNamespacedService(candidate, NAMESPACE)
      return candidate
    } catch {
      // not found, try next
    }
  }

  // Fallback: list services with userSlug prefix and find best match.
  // Handles cases where the project name in DB drifted from the name used at scaffold time.
  try {
    const res = await core.listNamespacedService(NAMESPACE)
    const prefix = `${userSlug}-`
    const match = res.body.items
      .map(s => s.metadata.name)
      .filter(n => n.startsWith(prefix))
      .find(n => {
        const part = n.slice(prefix.length)
        return name.startsWith(part) || part.startsWith(name)
      })
    return match ?? null
  } catch {
    return null
  }
}

function routeBlock(userSlug, name, svc) {
  return [
    `        # BEGIN PROJECT ${userSlug}/${name}`,
    `        location /${userSlug}/${name}/ {`,
    `            proxy_pass http://${svc}.user-projects.svc.cluster.local/;`,
    `            proxy_set_header Host $host;`,
    `            proxy_set_header X-Real-IP $remote_addr;`,
    `        }`,
    `        # END PROJECT ${userSlug}/${name}`,
  ].join('\n')
}

async function patchConfigMap(updater) {
  const { core } = makeClients()
  const res = await core.readNamespacedConfigMap(CONFIGMAP_NAME, NAMESPACE)
  const current = res.body.data['nginx.conf']
  const updated = updater(current)
  if (updated === current) return false
  await core.patchNamespacedConfigMap(
    CONFIGMAP_NAME,
    NAMESPACE,
    { data: { 'nginx.conf': updated } },
    undefined, undefined, undefined, undefined,
    undefined,
    { headers: { 'Content-Type': 'application/merge-patch+json' } }
  )
  return true
}

async function rollingRestart() {
  const { apps } = makeClients()
  await apps.patchNamespacedDeployment(
    DEPLOYMENT_NAME,
    NAMESPACE,
    {
      spec: {
        template: {
          metadata: {
            annotations: { 'kubectl.kubernetes.io/restartedAt': new Date().toISOString() },
          },
        },
      },
    },
    undefined, undefined, undefined, undefined,
    undefined,
    { headers: { 'Content-Type': 'application/merge-patch+json' } }
  )
}

export async function getRouterConfig() {
  const { core } = makeClients()
  const res = await core.readNamespacedConfigMap(CONFIGMAP_NAME, NAMESPACE)
  return res.body.data['nginx.conf']
}

export async function syncProjectRoutes(entries) {
  const resolved = (await Promise.all(
    entries.map(async ({ userSlug, name }) => {
      try {
        const svc = await resolveServiceName(userSlug, name)
        if (!svc) console.log(`[syncProjectRoutes] no service for ${userSlug}/${name}`)
        return svc ? { userSlug, name, svc } : null
      } catch (err) {
        console.log(`[syncProjectRoutes] resolveServiceName error ${userSlug}/${name}: ${err.message}`)
        return null
      }
    })
  )).filter(Boolean)

  console.log(`[syncProjectRoutes] resolved ${resolved.length}/${entries.length} entries`)
  if (resolved.length === 0) return

  const changed = await patchConfigMap(config => {
    const marker = '# PROJECT ROUTES — managed by hub-back, do not edit manually'
    if (!config.includes(marker)) throw new Error(`ConfigMap ${CONFIGMAP_NAME} missing marker`)
    let result = config
    for (const { userSlug, name, svc } of resolved) {
      if (result.includes(`# BEGIN PROJECT ${userSlug}/${name}`)) continue
      result = result.replace(marker, `${marker}\n${routeBlock(userSlug, name, svc)}`)
    }
    return result
  })

  if (changed) await rollingRestart()
}

export async function addProjectRoute(userSlug, name) {
  const svc = await resolveServiceName(userSlug, name)
  if (!svc) {
    throw new Error(`Service for ${userSlug}/${name} not found in namespace ${NAMESPACE} — route not added`)
  }
  const changed = await patchConfigMap(config => {
    const begin = `# BEGIN PROJECT ${userSlug}/${name}`
    if (config.includes(begin)) return config
    const marker = '# PROJECT ROUTES — managed by hub-back, do not edit manually'
    if (!config.includes(marker)) throw new Error(`ConfigMap ${CONFIGMAP_NAME} missing marker — was it edited manually?`)
    return config.replace(marker, `${marker}\n${routeBlock(userSlug, name, svc)}`)
  })
  if (changed) await rollingRestart()
}

export async function removeProjectRoute(userSlug, name) {
  const changed = await patchConfigMap(config => {
    const begin = `# BEGIN PROJECT ${userSlug}/${name}`
    const end = `# END PROJECT ${userSlug}/${name}`
    const startIdx = config.indexOf(begin)
    const endIdx = config.indexOf(end)
    if (startIdx === -1 || endIdx === -1) return config
    const head = config.slice(0, startIdx).trimEnd()
    const tail = config.slice(endIdx + end.length).replace(/^\s*\n/, '\n')
    return head + tail
  })
  if (changed) await rollingRestart()
}

export async function deleteProjectWorkload(userSlug, name) {
  const { core, apps } = makeClients()
  const workloadName = await resolveServiceName(userSlug, name) ?? serviceNameFor(userSlug, name)
  await apps.deleteNamespacedDeployment(workloadName, NAMESPACE).catch(() => {})
  await core.deleteNamespacedService(workloadName, NAMESPACE).catch(() => {})
}
