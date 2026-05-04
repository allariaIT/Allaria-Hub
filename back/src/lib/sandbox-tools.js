// back/src/lib/sandbox-tools.js
import { prisma } from './prisma.js'
import { createGitlabRepo } from './gitlab.js'
import {
  sandboxCreateProject, sandboxWriteFile, sandboxReadFile,
  sandboxListFiles, sandboxBuild, sandboxPush, sandboxStatus,
} from './sandbox-client.js'

const PREVIEW_BASE = process.env.SANDBOX_PREVIEW_URL || 'https://proyectos-sandbox.allaria.xyz:3099'

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
      description: 'Reconstruye el container Docker y deploya los cambios. Llama esto despues de modificar archivos para que el usuario vea los cambios en la preview.',
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
      description: 'Commitea y pushea los cambios a GitLab. Confirmá con el usuario antes de pushear.',
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
      const { gitlabId, repoUrl, webUrl } = await createGitlabRepo(userSlug, args.name)

      // 2. Crear en DB
      const project = await prisma.project.create({
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

      // 3. Crear en Sandbox Agent
      const result = await sandboxCreateProject(userSlug, args.name, args.title, repoUrl)

      // 4. Actualizar DB
      const previewUrl = `${PREVIEW_BASE}/${userSlug}/${args.name}/`
      // Crear chat dedicado si no existe
      let chatId = project.chatId
      if (!chatId) {
        const chat = await prisma.chat.create({
          data: { title: `🚧 ${args.title}`, userId },
        })
        chatId = chat.id
      }
      await prisma.project.update({
        where: { id: project.id },
        data: {
          port: result.port,
          previewUrl,
          status: 'running',
          chatId,
        },
      })

      return {
        message: `Proyecto "${args.title}" creado exitosamente.`,
        previewUrl,
        repoUrl: webUrl,
        status: 'running',
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
      await sandboxBuild(userSlug, args.projectName)
      await prisma.project.update({ where: { id: project.id }, data: { status: 'running' } })
      return { ok: true, message: 'Build completado. Preview actualizada.', previewUrl: project.previewUrl }
    }

    case 'sandbox_push': {
      const project = await prisma.project.findFirst({ where: { userId, name: args.projectName } })
      if (!project) throw new Error(`Proyecto "${args.projectName}" no encontrado`)
      const result = await sandboxPush(userSlug, args.projectName, args.message)
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
