import k8s from '@kubernetes/client-node'

const NAMESPACE = 'sandbox-sessions'
const IMAGE = 'swr.la-south-2.myhuaweicloud.com/sandbox-allaria/session-agent:latest'

function makeClient() {
  const kc = new k8s.KubeConfig()
  if (process.env.KUBERNETES_SERVICE_HOST) {
    kc.loadFromCluster()
  } else {
    kc.loadFromDefault()
  }
  return kc.makeApiClient(k8s.CoreV1Api)
}

export async function createSessionPod(sessionId, repoUrl, litellmUrl, litellmKey, backUrl) {
  const coreV1 = makeClient()

  const podSpec = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: `session-${sessionId}`,
      namespace: NAMESPACE,
      labels: { app: 'session-agent', sessionId },
    },
    spec: {
      restartPolicy: 'Never',
      terminationGracePeriodSeconds: 30,
      imagePullSecrets: [{ name: 'swr-pull-secret' }],
      containers: [
        {
          name: 'agent',
          image: IMAGE,
          ports: [{ containerPort: 3200 }],
          env: [
            { name: 'REPO_URL', value: repoUrl },
            { name: 'LITELLM_URL', value: litellmUrl || process.env.LITELLM_URL },
            { name: 'LITELLM_KEY', value: litellmKey || process.env.LITELLM_KEY },
            { name: 'SESSION_ID', value: sessionId },
            { name: 'BACK_URL', value: backUrl || 'http://back.allaria-hub.svc.cluster.local:3098' },
          ],
          resources: {
            requests: { cpu: '100m', memory: '256Mi' },
            limits: { cpu: '500m', memory: '512Mi' },
          },
          readinessProbe: {
            httpGet: { path: '/health', port: 3200 },
            initialDelaySeconds: 10,
            periodSeconds: 5,
          },
        },
      ],
    },
  }

  await coreV1.createNamespacedPod(NAMESPACE, podSpec)
  return `session-${sessionId}`
}

export async function waitForPodReady(podName, timeoutMs = 60_000) {
  const coreV1 = makeClient()
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const { body } = await coreV1.readNamespacedPod(podName, NAMESPACE)
    const phase = body.status?.phase
    const podIP = body.status?.podIP

    if (phase === 'Running' && podIP) {
      // Esperar que el readiness probe pase
      const conditions = body.status?.conditions || []
      const ready = conditions.find(c => c.type === 'Ready')
      if (ready?.status === 'True') return podIP
    }

    if (phase === 'Failed' || phase === 'Succeeded') {
      throw new Error(`Pod ${podName} terminó inesperadamente con phase: ${phase}`)
    }

    await new Promise(r => setTimeout(r, 3000))
  }

  throw new Error(`Pod ${podName} no estuvo listo en ${timeoutMs}ms`)
}

export async function deleteSessionPod(podName) {
  const coreV1 = makeClient()
  try {
    await coreV1.deleteNamespacedPod(podName, NAMESPACE)
  } catch (err) {
    // 404 = ya no existe, ignorar
    if (!err.body?.code === 404) throw err
  }
}

export async function getPodPhase(podName) {
  const coreV1 = makeClient()
  try {
    const { body } = await coreV1.readNamespacedPod(podName, NAMESPACE)
    return body.status?.phase || 'Unknown'
  } catch {
    return 'NotFound'
  }
}
