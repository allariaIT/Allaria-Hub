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
  return `${userSlug}-${name}`
}

function routeBlock(userSlug, name) {
  const svc = serviceNameFor(userSlug, name)
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
    { headers: { 'Content-Type': 'application/merge-patch+json' } }
  )
}

export async function addProjectRoute(userSlug, name) {
  const changed = await patchConfigMap(config => {
    const begin = `# BEGIN PROJECT ${userSlug}/${name}`
    if (config.includes(begin)) return config
    const marker = '# PROJECT ROUTES — managed by hub-back, do not edit manually'
    if (!config.includes(marker)) throw new Error(`ConfigMap ${CONFIGMAP_NAME} missing marker — was it edited manually?`)
    return config.replace(marker, `${marker}\n${routeBlock(userSlug, name)}`)
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
  const workloadName = serviceNameFor(userSlug, name)
  await apps.deleteNamespacedDeployment(workloadName, NAMESPACE).catch(() => {})
  await core.deleteNamespacedService(workloadName, NAMESPACE).catch(() => {})
}
