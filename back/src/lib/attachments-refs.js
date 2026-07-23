// Convierte adjuntos en refs de texto para guardar en el mensaje del usuario en DB.
export function attachmentsToRefs(attachments = []) {
  if (!Array.isArray(attachments) || attachments.length === 0) return ''
  return '\n' + attachments.map(a => `[📎 ${a.name}]`).join('\n')
}
