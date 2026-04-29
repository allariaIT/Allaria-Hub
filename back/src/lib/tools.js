import { gmailListMessages, gmailReadMessage, gmailSendMessage, gmailSearchMessages } from './gmail.js'
import { calendarListEvents, calendarCreateEvent, calendarSearchEvents } from './calendar.js'
import { tasksListAll, tasksCreate, tasksComplete, tasksSearch } from './gtasks.js'
import { driveListFiles, driveSearchFiles, driveGetFile } from './drive.js'

// Tools que requieren confirmación del usuario antes de ejecutarse
export const CONFIRMABLE_TOOLS = new Set([
  'gmail_send',
  'calendar_create',
  'tasks_create',
  'tasks_complete',
])

export const TOOL_DEFINITIONS = {
  gmail: [
    {
      type: 'function',
      function: {
        name: 'gmail_list',
        description: 'Lista los emails recientes del usuario. Usa el parámetro q para filtrar (sintaxis de Gmail search).',
        parameters: {
          type: 'object',
          properties: {
            q: { type: 'string', description: 'Query de búsqueda Gmail (ej: "is:unread", "from:juan@empresa.com"). Vacío para los más recientes.' },
            maxResults: { type: 'number', description: 'Cantidad máxima de emails a devolver (default 5, max 10)' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'gmail_read',
        description: 'Lee el contenido completo de un email específico por su ID.',
        parameters: {
          type: 'object',
          properties: {
            messageId: { type: 'string', description: 'ID del mensaje a leer' },
          },
          required: ['messageId'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'gmail_send',
        description: 'Envía un email en nombre del usuario. SIEMPRE confirmá con el usuario antes de enviar.',
        parameters: {
          type: 'object',
          properties: {
            to: { type: 'string', description: 'Email del destinatario' },
            subject: { type: 'string', description: 'Asunto del email' },
            body: { type: 'string', description: 'Cuerpo del email en texto plano' },
          },
          required: ['to', 'subject', 'body'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'gmail_search',
        description: 'Busca emails con un query específico. Sintaxis de Gmail search.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Query de búsqueda (ej: "subject:factura after:2026/01/01")' },
            maxResults: { type: 'number', description: 'Cantidad máxima (default 5)' },
          },
          required: ['query'],
        },
      },
    },
  ],

  calendar: [
    {
      type: 'function',
      function: {
        name: 'calendar_list',
        description: 'Lista los próximos eventos del calendario del usuario.',
        parameters: {
          type: 'object',
          properties: {
            maxResults: { type: 'number', description: 'Cantidad máxima de eventos (default 10)' },
            timeMin: { type: 'string', description: 'Fecha/hora mínima en ISO 8601 (default: ahora)' },
            timeMax: { type: 'string', description: 'Fecha/hora máxima en ISO 8601' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'calendar_create',
        description: 'Crea un evento en el calendario. SIEMPRE confirmá los detalles con el usuario antes de crear.',
        parameters: {
          type: 'object',
          properties: {
            summary: { type: 'string', description: 'Título del evento' },
            description: { type: 'string', description: 'Descripción del evento' },
            start: { type: 'string', description: 'Fecha/hora de inicio en ISO 8601 (ej: "2026-05-01T10:00:00-03:00")' },
            end: { type: 'string', description: 'Fecha/hora de fin en ISO 8601' },
            location: { type: 'string', description: 'Ubicación del evento' },
            attendees: { type: 'array', items: { type: 'string' }, description: 'Lista de emails de los invitados' },
          },
          required: ['summary', 'start', 'end'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'calendar_search',
        description: 'Busca eventos en el calendario por texto.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Texto a buscar en los eventos' },
            maxResults: { type: 'number', description: 'Cantidad máxima (default 5)' },
          },
          required: ['query'],
        },
      },
    },
  ],

  tasks: [
    {
      type: 'function',
      function: {
        name: 'tasks_list',
        description: 'Lista las tareas del usuario (Google Tasks).',
        parameters: {
          type: 'object',
          properties: {
            maxResults: { type: 'number', description: 'Cantidad máxima de tareas (default 20)' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'tasks_create',
        description: 'Crea una nueva tarea. Confirmá con el usuario antes de crear.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Título de la tarea' },
            notes: { type: 'string', description: 'Notas/descripción de la tarea' },
            due: { type: 'string', description: 'Fecha de vencimiento en ISO 8601 (ej: "2026-05-01T00:00:00Z")' },
          },
          required: ['title'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'tasks_complete',
        description: 'Marca una tarea como completada por su ID.',
        parameters: {
          type: 'object',
          properties: {
            taskId: { type: 'string', description: 'ID de la tarea a completar' },
          },
          required: ['taskId'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'tasks_search',
        description: 'Busca tareas por texto en título o notas.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Texto a buscar' },
          },
          required: ['query'],
        },
      },
    },
  ],

  drive: [
    {
      type: 'function',
      function: {
        name: 'drive_list',
        description: 'Lista los archivos recientes del Google Drive del usuario.',
        parameters: {
          type: 'object',
          properties: {
            maxResults: { type: 'number', description: 'Cantidad máxima de archivos (default 10)' },
            q: { type: 'string', description: 'Query de búsqueda de Drive (sintaxis de Drive API)' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'drive_search',
        description: 'Busca archivos en Google Drive por nombre.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Texto a buscar en el nombre del archivo' },
            maxResults: { type: 'number', description: 'Cantidad máxima (default 5)' },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'drive_get',
        description: 'Obtiene información detallada de un archivo de Drive por su ID.',
        parameters: {
          type: 'object',
          properties: {
            fileId: { type: 'string', description: 'ID del archivo' },
          },
          required: ['fileId'],
        },
      },
    },
  ],
}

export async function executeTool(toolCall, userId) {
  const { name, arguments: argsJson } = toolCall.function
  const args = JSON.parse(argsJson)

  switch (name) {
    // Gmail
    case 'gmail_list':
      return await gmailListMessages(userId, {
        maxResults: Math.min(args.maxResults || 5, 10),
        q: args.q || '',
      })
    case 'gmail_read':
      return await gmailReadMessage(userId, args.messageId)
    case 'gmail_send':
      return await gmailSendMessage(userId, args)
    case 'gmail_search':
      return await gmailSearchMessages(userId, args.query, Math.min(args.maxResults || 5, 10))

    // Calendar
    case 'calendar_list':
      return await calendarListEvents(userId, {
        maxResults: Math.min(args.maxResults || 10, 20),
        timeMin: args.timeMin,
        timeMax: args.timeMax,
      })
    case 'calendar_create':
      return await calendarCreateEvent(userId, args)
    case 'calendar_search':
      return await calendarSearchEvents(userId, args.query, Math.min(args.maxResults || 5, 10))

    // Tasks
    case 'tasks_list':
      return await tasksListAll(userId, { maxResults: Math.min(args.maxResults || 20, 50) })
    case 'tasks_create':
      return await tasksCreate(userId, args)
    case 'tasks_complete':
      return await tasksComplete(userId, args.taskId)
    case 'tasks_search':
      return await tasksSearch(userId, args.query)

    // Drive
    case 'drive_list':
      return await driveListFiles(userId, {
        maxResults: Math.min(args.maxResults || 10, 20),
        q: args.q || '',
      })
    case 'drive_search':
      return await driveSearchFiles(userId, args.query, Math.min(args.maxResults || 5, 10))
    case 'drive_get':
      return await driveGetFile(userId, args.fileId)

    default:
      return { error: `Tool desconocida: ${name}` }
  }
}

export function getToolsForConnectors(connectors) {
  const tools = []
  for (const conn of connectors) {
    const defs = TOOL_DEFINITIONS[conn]
    if (defs) tools.push(...defs)
  }
  return tools
}
