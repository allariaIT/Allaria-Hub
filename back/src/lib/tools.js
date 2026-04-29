import { gmailListMessages, gmailReadMessage, gmailSendMessage, gmailSearchMessages } from './gmail.js'

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
}

export async function executeTool(toolCall, userId) {
  const { name, arguments: argsJson } = toolCall.function
  const args = JSON.parse(argsJson)

  switch (name) {
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
