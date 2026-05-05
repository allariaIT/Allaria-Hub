import { Router } from 'express'
import { prisma } from '../lib/prisma.js'

export const chatRouter = Router()

// GET /api/chats - Listar chats del usuario (excluye chats de proyectos sandbox)
chatRouter.get('/', async (req, res) => {
  const projectChats = await prisma.project.findMany({
    where: { userId: req.user.id, chatId: { not: null } },
    select: { chatId: true },
  })
  const excludeIds = projectChats.map(p => p.chatId).filter(Boolean)

  const chats = await prisma.chat.findMany({
    where: { userId: req.user.id, id: { notIn: excludeIds } },
    orderBy: { updatedAt: 'desc' },
    include: {
      messages: {
        orderBy: { createdAt: 'asc' },
      },
    },
  })
  res.json(chats)
})

// POST /api/chats - Crear nuevo chat
chatRouter.post('/', async (req, res) => {
  const { title } = req.body
  const chat = await prisma.chat.create({
    data: {
      title: title || 'Nuevo chat',
      userId: req.user.id,
    },
    include: { messages: true },
  })
  res.json(chat)
})

// GET /api/chats/:id - Obtener chat con mensajes
chatRouter.get('/:id', async (req, res) => {
  const chat = await prisma.chat.findFirst({
    where: { id: req.params.id, userId: req.user.id },
    include: {
      messages: {
        orderBy: { createdAt: 'asc' },
      },
    },
  })
  if (!chat) return res.status(404).json({ error: 'Chat no encontrado' })
  res.json(chat)
})

// PATCH /api/chats/:id - Actualizar título
chatRouter.patch('/:id', async (req, res) => {
  const { title } = req.body
  const chat = await prisma.chat.updateMany({
    where: { id: req.params.id, userId: req.user.id },
    data: { title },
  })
  if (chat.count === 0) return res.status(404).json({ error: 'Chat no encontrado' })
  res.json({ ok: true })
})

// DELETE /api/chats/:id - Eliminar chat
chatRouter.delete('/:id', async (req, res) => {
  const deleted = await prisma.chat.deleteMany({
    where: { id: req.params.id, userId: req.user.id },
  })
  if (deleted.count === 0) return res.status(404).json({ error: 'Chat no encontrado' })
  res.json({ ok: true })
})

// DELETE /api/chats/:id/messages - Limpiar mensajes de un chat
chatRouter.delete('/:id/messages', async (req, res) => {
  const chat = await prisma.chat.findFirst({
    where: { id: req.params.id, userId: req.user.id },
  })
  if (!chat) return res.status(404).json({ error: 'Chat no encontrado' })

  await prisma.message.deleteMany({ where: { chatId: chat.id } })
  await prisma.chat.update({
    where: { id: chat.id },
    data: { title: 'Nuevo chat' },
  })
  res.json({ ok: true })
})
