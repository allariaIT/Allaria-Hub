import fs from 'node:fs'
import path from 'node:path'

const WORKSPACE = process.env.WORKSPACE_DIR || '/workspace'
const ATTACH_DIRNAME = '.attachments'

// Solo el basename, sin separadores ni prefijos relativos
function sanitizeName(name) {
  const noControl = String(name ?? '').replace(/[\r\n\t\x00-\x1f]/g, '')
  const base = path.basename(noControl.trim())
  const cleaned = base.replace(/[/\\]/g, '').replace(/^\.+/, '')
  return cleaned || 'archivo'
}

// Agrega -1, -2, ... antes de la extensión si el nombre ya existe
function uniqueName(dir, name) {
  const ext = path.extname(name)
  const stem = ext ? name.slice(0, -ext.length) : name
  let candidate = name
  let i = 1
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${stem}-${i}${ext}`
    i++
  }
  return candidate
}

// Extrae los bytes de un data URL (o base64 crudo)
function decodeBase64(b64) {
  const comma = b64.indexOf(',')
  const raw = b64.startsWith('data:') && comma !== -1 ? b64.slice(comma + 1) : b64
  return Buffer.from(raw, 'base64')
}

export function writeAttachments(attachments = []) {
  if (!Array.isArray(attachments) || attachments.length === 0) return []
  const dir = path.join(WORKSPACE, ATTACH_DIRNAME)
  fs.mkdirSync(dir, { recursive: true })

  const written = []
  for (const att of attachments) {
    try {
      const finalName = uniqueName(dir, sanitizeName(att.name))
      const dest = path.join(dir, finalName)
      if (!path.resolve(dest).startsWith(path.resolve(dir) + path.sep)) {
        console.warn(`[attachments] path inválido, se saltea: ${att.name}`)
        continue
      }
      if (typeof att.textContent === 'string') {
        fs.writeFileSync(dest, att.textContent, 'utf-8')
      } else if (typeof att.base64 === 'string') {
        fs.writeFileSync(dest, decodeBase64(att.base64))
      } else {
        console.warn(`[attachments] sin contenido, se saltea: ${att.name}`)
        continue
      }
      written.push({
        name: finalName,
        mimeType: att.type || '',
        path: `${ATTACH_DIRNAME}/${finalName}`,
        base64: typeof att.base64 === 'string' ? att.base64 : undefined,
      })
    } catch (err) {
      console.warn(`[attachments] error escribiendo ${att?.name}: ${err.message}`)
    }
  }
  return written
}
