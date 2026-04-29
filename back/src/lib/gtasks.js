import { google } from 'googleapis'
import { getAuthedClient } from './google-oauth.js'
import { prisma } from './prisma.js'

async function getTasksClient(userId) {
  const conn = await prisma.userConnection.findUnique({
    where: { userId_provider: { userId, provider: 'tasks' } },
  })
  if (!conn) throw new Error('Tasks no conectado. Pedile al usuario que conecte Tasks desde el panel de conectores.')

  const auth = getAuthedClient(conn.accessToken, conn.refreshToken)

  // Listener para auto-actualizar tokens
  auth.on('tokens', async (tokens) => {
    const update = { accessToken: tokens.access_token }
    if (tokens.refresh_token) update.refreshToken = tokens.refresh_token
    if (tokens.expiry_date) update.expiresAt = new Date(tokens.expiry_date)
    await prisma.userConnection.update({
      where: { id: conn.id },
      data: update,
    })
  })

  return google.tasks({ version: 'v1', auth })
}

function parseTask(task) {
  return {
    id: task.id,
    title: task.title,
    notes: task.notes || '',
    status: task.status,
    due: task.due || null,
    updated: task.updated || null,
  }
}

export async function tasksListAll(userId, { maxResults = 20 } = {}) {
  const tasks = await getTasksClient(userId)

  const listsRes = await tasks.tasklists.list({ maxResults: 1 })
  const lists = listsRes.data.items || []
  if (!lists.length) return { tasks: [], total: 0 }

  const listId = lists[0].id

  const res = await tasks.tasks.list({
    tasklist: listId,
    maxResults,
    showCompleted: true,
  })

  const items = (res.data.items || []).map(parseTask)
  return { tasks: items, total: items.length }
}

export async function tasksCreate(userId, { title, notes, due }) {
  const tasksClient = await getTasksClient(userId)

  const listsRes = await tasksClient.tasklists.list({ maxResults: 1 })
  const lists = listsRes.data.items || []
  if (!lists.length) throw new Error('No se encontró ninguna lista de tareas.')

  const listId = lists[0].id

  const body = { title }
  if (notes) body.notes = notes
  if (due) body.due = due

  const res = await tasksClient.tasks.insert({
    tasklist: listId,
    requestBody: body,
  })

  return {
    id: res.data.id,
    title: res.data.title,
    status: res.data.status,
  }
}

export async function tasksComplete(userId, taskId) {
  const tasksClient = await getTasksClient(userId)

  const listsRes = await tasksClient.tasklists.list({ maxResults: 1 })
  const lists = listsRes.data.items || []
  if (!lists.length) throw new Error('No se encontró ninguna lista de tareas.')

  const listId = lists[0].id

  const res = await tasksClient.tasks.patch({
    tasklist: listId,
    task: taskId,
    requestBody: { status: 'completed' },
  })

  return {
    id: res.data.id,
    title: res.data.title,
    status: res.data.status,
  }
}

export async function tasksSearch(userId, query) {
  const { tasks, total } = await tasksListAll(userId, { maxResults: 100 })

  const lowerQuery = query.toLowerCase()
  const filtered = tasks.filter((task) => {
    const inTitle = (task.title || '').toLowerCase().includes(lowerQuery)
    const inNotes = (task.notes || '').toLowerCase().includes(lowerQuery)
    return inTitle || inNotes
  })

  return { tasks: filtered, total: filtered.length }
}
