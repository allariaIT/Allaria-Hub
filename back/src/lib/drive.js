import { google } from 'googleapis'
import { getAuthedClient } from './google-oauth.js'
import { prisma } from './prisma.js'

async function getDriveClient(userId) {
  const conn = await prisma.userConnection.findUnique({
    where: { userId_provider: { userId, provider: 'drive' } },
  })
  if (!conn) throw new Error('Drive no conectado. Pedile al usuario que conecte Drive desde el panel de conectores.')

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

  return google.drive({ version: 'v3', auth })
}

const FILE_FIELDS = 'id, name, mimeType, size, modifiedTime, webViewLink, iconLink'

export async function driveListFiles(userId, { maxResults = 10, q = '' } = {}) {
  const drive = await getDriveClient(userId)

  const query = q
    ? `${q} and trashed = false`
    : 'trashed = false'

  const res = await drive.files.list({
    pageSize: maxResults,
    q: query,
    orderBy: 'modifiedTime desc',
    fields: `files(${FILE_FIELDS}), nextPageToken`,
  })

  const files = res.data.files || []

  return { files, total: files.length }
}

export async function driveSearchFiles(userId, query, maxResults = 5) {
  return driveListFiles(userId, {
    maxResults,
    q: `name contains '${query}'`,
  })
}

export async function driveGetFile(userId, fileId) {
  const drive = await getDriveClient(userId)

  const res = await drive.files.get({
    fileId,
    fields: 'id, name, mimeType, size, modifiedTime, webViewLink, owners, shared',
  })

  const f = res.data
  return {
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    size: f.size,
    modifiedTime: f.modifiedTime,
    webViewLink: f.webViewLink,
    owners: f.owners,
    shared: f.shared,
  }
}
