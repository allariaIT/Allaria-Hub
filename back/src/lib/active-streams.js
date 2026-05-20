// Buffer en memoria de streams SSE activos por chatId.
// Permite que un cliente que se desconecta a mitad del procesamiento se reconecte
// y reciba todos los eventos que se perdió + siga viendo los que faltan en vivo.

const streams = new Map() // chatId -> { events, status, subscribers, startedAt, endedAt }

const KEEP_FINISHED_MS = 5 * 60_000 // mantener buffers terminados 5min para reconexiones tardías

export function startStream(chatId) {
  const existing = streams.get(chatId)
  if (existing) {
    // Limpiar subscribers anteriores y reiniciar
    for (const sub of existing.subscribers) {
      try { sub.end?.() } catch {}
    }
  }
  streams.set(chatId, {
    events: [],
    status: 'running',
    subscribers: new Set(),
    startedAt: Date.now(),
    endedAt: null,
  })
}

export function pushEvent(chatId, event) {
  const stream = streams.get(chatId)
  if (!stream) return
  stream.events.push(event)
  // Cap del buffer: si pasa de 500 eventos, descartar los más viejos manteniendo el primer evento de tipo 'thinking' inicial
  if (stream.events.length > 500) {
    stream.events.splice(0, stream.events.length - 500)
  }
  for (const sub of stream.subscribers) {
    try { sub.write(`data: ${JSON.stringify(event)}\n\n`) } catch {}
  }
}

export function endStream(chatId, finalStatus = 'done') {
  const stream = streams.get(chatId)
  if (!stream) return
  stream.status = finalStatus
  stream.endedAt = Date.now()
  // Notificar a subscribers que el stream terminó
  for (const sub of stream.subscribers) {
    try {
      sub.write(`data: ${JSON.stringify({ type: '_stream_ended', status: finalStatus })}\n\n`)
      sub.end?.()
    } catch {}
  }
  stream.subscribers.clear()
  // Programar limpieza del buffer
  setTimeout(() => {
    const s = streams.get(chatId)
    if (s && s.status !== 'running') streams.delete(chatId)
  }, KEEP_FINISHED_MS)
}

export function subscribe(chatId, res) {
  const stream = streams.get(chatId)
  if (!stream) return false
  // Replay del buffer
  for (const event of stream.events) {
    try { res.write(`data: ${JSON.stringify(event)}\n\n`) } catch {}
  }
  if (stream.status !== 'running') {
    try {
      res.write(`data: ${JSON.stringify({ type: '_stream_ended', status: stream.status })}\n\n`)
      res.end?.()
    } catch {}
    return true
  }
  stream.subscribers.add(res)
  return true
}

export function unsubscribe(chatId, res) {
  const stream = streams.get(chatId)
  if (!stream) return
  stream.subscribers.delete(res)
}

export function getSnapshot(chatId) {
  const stream = streams.get(chatId)
  if (!stream) return null
  return {
    status: stream.status,
    events: stream.events,
    startedAt: stream.startedAt,
    endedAt: stream.endedAt,
  }
}
