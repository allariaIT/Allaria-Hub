// back/src/lib/sandbox-tools.js
import { prisma } from './prisma.js'
import { createGitlabRepo, deleteGitlabRepo } from './gitlab.js'
import {
  sandboxCreateProject, sandboxWriteFile, sandboxReadFile,
  sandboxListFiles, sandboxBuild, sandboxPush, sandboxStatus,
} from './sandbox-client.js'

const PREVIEW_BASE = process.env.SANDBOX_PREVIEW_URL || 'https://proyectos-sandbox.allaria.xyz'
const GITLAB_TOKEN = process.env.GITLAB_TOKEN
const GITLAB_URL = process.env.GITLAB_URL || 'https://gitlab.allaria.xyz'

function fmtDuration(start, end) {
  if (!start || !end) return null
  const secs = Math.round((new Date(end) - new Date(start)) / 1000)
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

export async function pollGitlabPipeline(gitlabId, afterTime, { onStage, maxAttempts = 40, delayMs = 15000 } = {}) {
  await new Promise(r => setTimeout(r, 8000))
  let pipelineId = null
  const jobStates = {} // { jobName: lastKnownStatus } — evita emitir duplicados

  for (let i = 0; i < maxAttempts; i++) {
    let cachedJobs = null
    try {
      const res = await fetch(
        `${GITLAB_URL}/api/v4/projects/${gitlabId}/pipelines?per_page=5&order_by=id&sort=desc`,
        { headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN }, signal: AbortSignal.timeout(10000) }
      )
      const pipelines = await res.json()

      if (!pipelineId) {
        const recent = pipelines.find(p => new Date(p.created_at) >= afterTime)
        if (recent) pipelineId = recent.id
      }

      if (pipelineId) {
        const p = pipelines.find(p => p.id === pipelineId)

        // Consultar jobs para saber qué etapa está corriendo
        if (onStage) {
          try {
            const jobsRes = await fetch(
              `${GITLAB_URL}/api/v4/projects/${gitlabId}/pipelines/${pipelineId}/jobs`,
              { headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN }, signal: AbortSignal.timeout(10000) }
            )
            cachedJobs = await jobsRes.json()
            for (const job of cachedJobs) {
              if (['running', 'success', 'failed'].includes(job.status) && jobStates[job.name] !== job.status) {
                jobStates[job.name] = job.status
                onStage(job.name, job.status)
              }
            }
          } catch {}
        }

        if (p) {
          if (p.status === 'success') {
            // Calcular duraciones desde started_at/finished_at de cada job
            let duration = {}
            try {
              const jobs = cachedJobs ?? await (async () => {
                const r = await fetch(
                  `${GITLAB_URL}/api/v4/projects/${gitlabId}/pipelines/${pipelineId}/jobs`,
                  { headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN }, signal: AbortSignal.timeout(10000) }
                )
                return r.json()
              })()
              const build = jobs.find(j => j.name === 'docker:build')
              const deploy = jobs.find(j => j.name === 'deploy:server')
              if (build) duration.build = fmtDuration(build.started_at, build.finished_at)
              if (deploy) duration.deploy = fmtDuration(deploy.started_at, deploy.finished_at)
            } catch {}
            return { ok: true, duration }
          }
          if (p.status === 'failed' || p.status === 'canceled') {
            // Encontrar el job que falló
            let failedJob = null
            try {
              const jobsRes = await fetch(
                `${GITLAB_URL}/api/v4/projects/${gitlabId}/pipelines/${pipelineId}/jobs`,
                { headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN }, signal: AbortSignal.timeout(10000) }
              )
              const jobs = await jobsRes.json()
              const failed = jobs.find(j => j.status === 'failed')
              if (failed) failedJob = failed.name
            } catch {}
            return { ok: false, failedJob, message: `Pipeline CI ${p.status}` }
          }
        }
      }
    } catch {}

    await new Promise(r => setTimeout(r, delayMs))
  }

  return { ok: false, failedJob: null, message: 'Timeout esperando pipeline CI (10 min). Revisá GitLab.' }
}

function repoUrlWithAuth(url) {
  if (!url || !GITLAB_TOKEN) return url
  const cloneUrl = url.endsWith('.git') ? url : url + '.git'
  return cloneUrl.replace(/https:\/\/gitlab\.allaria\.xyz/, `http://oauth2:${GITLAB_TOKEN}@gitlab`)
}

function userSlugFromEmail(email) {
  // juan.perez@allaria.com -> juan-perez
  const local = email.split('@')[0]
  return local.replace(/\./g, '-').toLowerCase()
}

export const SANDBOX_TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'sandbox_create_project',
      description: 'Crea un nuevo proyecto web con Vite+React. Genera scaffold, buildea container Docker y deploya preview. Confirmá nombre y titulo con el usuario antes de crear.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nombre slug del proyecto (ej: "dashboard-ventas"). Solo letras minusculas, numeros y guiones.' },
          title: { type: 'string', description: 'Titulo legible del proyecto (ej: "Dashboard de Ventas")' },
          description: { type: 'string', description: 'Descripcion opcional del proyecto' },
        },
        required: ['name', 'title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'sandbox_write_file',
      description: 'Escribe o sobreescribe un archivo en el proyecto. Usa esto para crear o modificar archivos de codigo.',
      parameters: {
        type: 'object',
        properties: {
          projectName: { type: 'string', description: 'Nombre slug del proyecto' },
          filePath: { type: 'string', description: 'Path relativo del archivo (ej: "src/App.jsx")' },
          content: { type: 'string', description: 'Contenido completo del archivo' },
        },
        required: ['projectName', 'filePath', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'sandbox_read_file',
      description: 'Lee el contenido de un archivo del proyecto.',
      parameters: {
        type: 'object',
        properties: {
          projectName: { type: 'string', description: 'Nombre slug del proyecto' },
          filePath: { type: 'string', description: 'Path relativo del archivo' },
        },
        required: ['projectName', 'filePath'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'sandbox_list_files',
      description: 'Lista la estructura de archivos del proyecto.',
      parameters: {
        type: 'object',
        properties: {
          projectName: { type: 'string', description: 'Nombre slug del proyecto' },
        },
        required: ['projectName'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'sandbox_build',
      description: 'Commitea y pushea los cambios al repo, dispara el pipeline CI que buildea y deploya la preview. Llamá esto después de modificar archivos. Espera hasta que el deploy esté completo.',
      parameters: {
        type: 'object',
        properties: {
          projectName: { type: 'string', description: 'Nombre slug del proyecto' },
        },
        required: ['projectName'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'sandbox_push',
      description: 'Commitea y pushea los cambios al repo. Llamá esto automáticamente después de cada sandbox_build exitoso, sin pedir confirmación al usuario.',
      parameters: {
        type: 'object',
        properties: {
          projectName: { type: 'string', description: 'Nombre slug del proyecto' },
          message: { type: 'string', description: 'Mensaje del commit' },
        },
        required: ['projectName', 'message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'sandbox_status',
      description: 'Devuelve el estado del proyecto (running/stopped, URL de preview, puerto, etc.).',
      parameters: {
        type: 'object',
        properties: {
          projectName: { type: 'string', description: 'Nombre slug del proyecto' },
        },
        required: ['projectName'],
      },
    },
  },
]

export async function executeSandboxTool(name, args, userId) {
  const user = await prisma.user.findUnique({ where: { id: userId } })
  if (!user) throw new Error('Usuario no encontrado')
  const userSlug = userSlugFromEmail(user.email)

  switch (name) {
    case 'sandbox_create_project': {
      // 1. Crear repo en GitLab
      let gitlabId, repoUrl, webUrl
      try {
        const gitlab = await createGitlabRepo(userSlug, args.name)
        gitlabId = gitlab.gitlabId
        repoUrl = gitlab.repoUrl
        webUrl = gitlab.webUrl
      } catch (err) {
        throw new Error(`Error creando repo en GitLab: ${err.message}`)
      }

      // 2. Crear en DB
      let project
      try {
        project = await prisma.project.create({
          data: {
            name: args.name,
            title: args.title,
            description: args.description || null,
            userId,
            gitlabId,
            repoUrl: webUrl,
            status: 'creating',
            template: 'vite-react',
          },
        })
      } catch (err) {
        // Rollback GitLab
        try { await deleteGitlabRepo(gitlabId) } catch {}
        throw err
      }

      // 3. Crear chat dedicado
      let chatId = project.chatId
      if (!chatId) {
        const chat = await prisma.chat.create({
          data: { title: `🚧 ${args.title}`, userId },
        })
        chatId = chat.id
      }

      // 4. Llamar al sandbox agent (con token embebido en la URL para que git push funcione)
      let port
      try {
        const result = await sandboxCreateProject(userSlug, args.name, args.title, repoUrlWithAuth(repoUrl))
        port = result.port
      } catch (err) {
        // Rollback DB + Chat + GitLab
        await prisma.project.delete({ where: { id: project.id } }).catch(() => {})
        if (chatId) await prisma.chat.delete({ where: { id: chatId } }).catch(() => {})
        try { await deleteGitlabRepo(gitlabId) } catch {}
        throw new Error(`Error al iniciar el sandbox: ${err.message}`)
      }

      const previewUrl = `${PREVIEW_BASE}/${userSlug}/${args.name}/`
      await prisma.project.update({
        where: { id: project.id },
        data: { port, previewUrl, chatId, status: 'creating' },
      })

      // 5. Polling del pipeline CI en GitLab
      const createStart = new Date()
      const ciResult = await pollGitlabPipeline(gitlabId, createStart)
      if (ciResult.ok) {
        await prisma.project.update({ where: { id: project.id }, data: { status: 'running' } })
        return {
          message: `Proyecto "${args.title}" creado y deployado exitosamente.`,
          previewUrl,
          repoUrl: webUrl,
          status: 'running',
        }
      } else {
        await prisma.project.update({ where: { id: project.id }, data: { status: 'error' } })
        return {
          message: `Proyecto "${args.title}" creado pero el pipeline CI falló: ${ciResult.message}`,
          previewUrl,
          status: 'error',
        }
      }
    }

    case 'sandbox_write_file': {
      const project = await prisma.project.findFirst({ where: { userId, name: args.projectName } })
      if (!project) throw new Error(`Proyecto "${args.projectName}" no encontrado`)
      await sandboxWriteFile(userSlug, args.projectName, args.filePath, args.content)
      return { ok: true, message: `Archivo ${args.filePath} escrito.` }
    }

    case 'sandbox_read_file': {
      const project = await prisma.project.findFirst({ where: { userId, name: args.projectName } })
      if (!project) throw new Error(`Proyecto "${args.projectName}" no encontrado`)
      return await sandboxReadFile(userSlug, args.projectName, args.filePath)
    }

    case 'sandbox_list_files': {
      const project = await prisma.project.findFirst({ where: { userId, name: args.projectName } })
      if (!project) throw new Error(`Proyecto "${args.projectName}" no encontrado`)
      return await sandboxListFiles(userSlug, args.projectName)
    }

    case 'sandbox_build': {
      const project = await prisma.project.findFirst({ where: { userId, name: args.projectName } })
      if (!project) throw new Error(`Proyecto "${args.projectName}" no encontrado`)

      const pushStart = new Date()
      const pushResult = await sandboxBuild(userSlug, args.projectName, repoUrlWithAuth(project.repoUrl))

      // Sin cambios → ya estaba running
      if (pushResult.status === 'running') {
        return { ok: true, message: 'Sin cambios para deployar. La preview ya está actualizada.', previewUrl: project.previewUrl }
      }

      // Error en el push
      if (!pushResult.ok) {
        await prisma.project.update({ where: { id: project.id }, data: { status: 'error' } })
        return { ok: false, message: pushResult.error || 'Error al pushear el código.' }
      }

      // Polling del pipeline CI en GitLab
      const ciResult = await pollGitlabPipeline(project.gitlabId, pushStart)
      if (ciResult.ok) {
        await prisma.project.update({ where: { id: project.id }, data: { status: 'running' } })
        return { ok: true, message: 'Deploy completado. Preview actualizada.', previewUrl: project.previewUrl }
      } else {
        await prisma.project.update({ where: { id: project.id }, data: { status: 'error' } })
        return { ok: false, message: ciResult.message || 'El pipeline CI falló.' }
      }
    }

    case 'sandbox_push': {
      const project = await prisma.project.findFirst({ where: { userId, name: args.projectName } })
      if (!project) throw new Error(`Proyecto "${args.projectName}" no encontrado`)
      const result = await sandboxPush(userSlug, args.projectName, args.message, repoUrlWithAuth(project.repoUrl))
      return { ...result, repoUrl: project.repoUrl }
    }

    case 'sandbox_status': {
      const project = await prisma.project.findFirst({ where: { userId, name: args.projectName } })
      if (!project) throw new Error(`Proyecto "${args.projectName}" no encontrado`)
      const agentStatus = await sandboxStatus(userSlug, args.projectName)
      return {
        name: project.name,
        title: project.title,
        status: agentStatus.status,
        previewUrl: project.previewUrl,
        repoUrl: project.repoUrl,
        port: project.port,
      }
    }

    default:
      throw new Error(`Tool sandbox desconocida: ${name}`)
  }
}
