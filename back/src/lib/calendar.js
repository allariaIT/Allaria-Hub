import { google } from 'googleapis'
import { getAuthedClient } from './google-oauth.js'
import { prisma } from './prisma.js'

async function getCalendarClient(userId) {
  const conn = await prisma.userConnection.findUnique({
    where: { userId_provider: { userId, provider: 'calendar' } },
  })
  if (!conn) throw new Error('Calendar no conectado. Pedile al usuario que conecte Calendar desde el panel de conectores.')

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

  return google.calendar({ version: 'v3', auth })
}

function parseEvent(event) {
  return {
    id: event.id,
    summary: event.summary || '',
    description: event.description || '',
    start: event.start,
    end: event.end,
    location: event.location || '',
    attendees: event.attendees || [],
    htmlLink: event.htmlLink || '',
  }
}

export async function calendarListEvents(userId, { maxResults = 10, timeMin, timeMax } = {}) {
  const calendar = await getCalendarClient(userId)
  const res = await calendar.events.list({
    calendarId: 'primary',
    maxResults,
    timeMin: timeMin || new Date().toISOString(),
    timeMax: timeMax || undefined,
    singleEvents: true,
    orderBy: 'startTime',
  })

  const items = res.data.items || []
  const events = items.map(parseEvent)

  return { events, total: events.length }
}

export async function calendarCreateEvent(userId, { summary, description, start, end, location, attendees }) {
  const calendar = await getCalendarClient(userId)

  const requestBody = {
    summary,
    description,
    location,
    start: { dateTime: start, timeZone: 'UTC' },
    end: { dateTime: end, timeZone: 'UTC' },
  }

  if (attendees?.length) {
    requestBody.attendees = attendees.map((email) => ({ email }))
  }

  const res = await calendar.events.insert({
    calendarId: 'primary',
    requestBody,
  })

  return {
    id: res.data.id,
    htmlLink: res.data.htmlLink,
    summary: res.data.summary,
    start: res.data.start,
    end: res.data.end,
  }
}

export async function calendarSearchEvents(userId, query, maxResults = 5) {
  const calendar = await getCalendarClient(userId)
  const res = await calendar.events.list({
    calendarId: 'primary',
    maxResults,
    q: query,
    singleEvents: true,
    orderBy: 'startTime',
  })

  const items = res.data.items || []
  const events = items.map(parseEvent)

  return { events, total: events.length }
}
