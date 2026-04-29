import { google } from 'googleapis'

const SCOPES_MAP = {
  gmail: [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.modify',
  ],
}

function createOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  )
}

export function getAuthUrl(provider, userId) {
  const client = createOAuth2Client()
  const scopes = SCOPES_MAP[provider]
  if (!scopes) throw new Error(`Provider desconocido: ${provider}`)

  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: scopes,
    state: JSON.stringify({ provider, userId }),
  })
}

export async function exchangeCode(code) {
  const client = createOAuth2Client()
  const { tokens } = await client.getToken(code)
  return tokens
}

export function getAuthedClient(accessToken, refreshToken) {
  const client = createOAuth2Client()
  client.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken,
  })
  return client
}

export { SCOPES_MAP }
