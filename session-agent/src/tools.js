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
      description: 'Lee el contenido de un archivo del proyecto.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relativo desde la raíz del proyecto (ej: "src/App.jsx")' },
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
      return { content: fs.readFileSync(resolved, 'utf-8') }
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
      return {
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        exitCode: result.status ?? 1,
      }
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
