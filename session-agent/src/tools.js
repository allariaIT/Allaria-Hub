import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { gitCommitAndPush, getChangedFiles } from './git.js'

const WORKSPACE = process.env.WORKSPACE_DIR || '/workspace'

const BASH_ALLOWLIST = new Set(['npm', 'npx', 'node', 'cat', 'ls', 'mkdir', 'cp', 'mv'])

function safePath(filePath) {
  const resolved = path.resolve(WORKSPACE, filePath)
  if (!resolved.startsWith(WORKSPACE + path.sep) && resolved !== WORKSPACE)
    throw new Error(`Path inválido: ${filePath}`)
  return resolved
}

function walkDir(dir, prefix = '') {
  const entries = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', '.next'].includes(entry.name)) continue
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    entries.push({ path: rel, type: entry.isDirectory() ? 'dir' : 'file' })
    if (entry.isDirectory()) entries.push(...walkDir(path.join(dir, entry.name), rel))
  }
  return entries
}

export const toolDefinitions = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Lee el contenido de un archivo. Para archivos grandes usa offset para leer por partes (ej: offset=150 para ver desde la línea 150).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relativo desde la raíz del proyecto (ej: "src/App.jsx")' },
          offset: { type: 'number', description: 'Línea desde la que empezar (default: 0). Usá esto para leer la segunda mitad de archivos grandes.' },
          limit: { type: 'number', description: 'Cantidad de líneas a leer (default: 150, max: 200).' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Escribe o sobreescribe un archivo del proyecto con el contenido completo.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relativo del archivo' },
          content: { type: 'string', description: 'Contenido completo del archivo' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'Lista la estructura de archivos del proyecto.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Ejecuta un comando de desarrollo. Permitidos: npm, npx, node, cat, ls, mkdir, cp, mv.',
      parameters: {
        type: 'object',
        properties: {
          cmd: { type: 'string', description: 'Comando a ejecutar (ej: "npm install react-query")' },
        },
        required: ['cmd'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_push',
      description: 'Commitea y pushea los cambios al repositorio. Llamá esto cuando terminés todos los cambios de la tarea.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Mensaje descriptivo del commit' },
        },
        required: ['message'],
      },
    },
  },
]

export async function executeTool(name, input) {
  switch (name) {
    case 'read_file': {
      const resolved = safePath(input.path)
      if (!fs.existsSync(resolved)) return { error: `Archivo no encontrado: ${input.path}` }
      const content = fs.readFileSync(resolved, 'utf-8')
      const lines = content.split('\n')
      const offset = Math.max(0, Math.floor(input.offset) || 0)
      const limit = Math.min(200, Math.max(1, Math.floor(input.limit) || 150))
      const slice = lines.slice(offset, offset + limit)
      const result = {
        content: slice.join('\n'),
        totalLines: lines.length,
      }
      if (offset > 0 || offset + limit < lines.length) {
        result.showing = `líneas ${offset + 1}–${Math.min(offset + limit, lines.length)} de ${lines.length}`
      }
      if (offset + limit < lines.length) {
        result.hasMore = true
        result.nextOffset = offset + limit
        result.hint = `Hay más contenido. Llamá read_file con offset=${offset + limit} para continuar.`
      }
      return result
    }

    case 'write_file': {
      const resolved = safePath(input.path)
      fs.mkdirSync(path.dirname(resolved), { recursive: true })
      fs.writeFileSync(resolved, input.content)
      return { ok: true, path: input.path }
    }

    case 'list_files': {
      if (!fs.existsSync(WORKSPACE)) return { error: 'Workspace no encontrado' }
      return { files: walkDir(WORKSPACE) }
    }

    case 'bash': {
      const cmd = input.cmd.trim()
      const parts = cmd.split(/\s+/)
      const bin = parts[0]
      if (!BASH_ALLOWLIST.has(bin)) {
        return { error: `Comando no permitido: "${bin}". Permitidos: ${[...BASH_ALLOWLIST].join(', ')}` }
      }
      const result = spawnSync(bin, parts.slice(1), {
        cwd: WORKSPACE,
        encoding: 'utf-8',
        timeout: 300_000, // 5 min — npm install puede tardar
      })
      // Truncar output para no explotar el contexto (npm install puede ser enorme)
      const MAX_OUT = 2_000
      let stdout = result.stdout || ''
      let stderr = result.stderr || ''
      if (stdout.length > MAX_OUT) stdout = '...[omitido]\n' + stdout.slice(-MAX_OUT)
      if (stderr.length > MAX_OUT) stderr = '...[omitido]\n' + stderr.slice(-MAX_OUT)
      return { stdout, stderr, exitCode: result.status ?? 1 }
    }

    case 'git_push': {
      try {
        const result = gitCommitAndPush(WORKSPACE, input.message)
        if (!result.pushed) return { ok: false, message: result.message }
        const files = getChangedFiles(WORKSPACE)
        return { ok: true, pushed: true, commit: result.commit, filesChanged: files }
      } catch (err) {
        return { ok: false, error: err.message }
      }
    }

    default:
      return { error: `Tool desconocida: ${name}` }
  }
}
