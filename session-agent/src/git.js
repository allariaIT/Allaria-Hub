import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf-8', timeout: 120_000 })
  if (result.error) throw new Error(`${cmd} error: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(' ')} falló:\n${result.stderr || result.stdout}`)
  return result.stdout.trim()
}

export function gitClone(repoUrl, targetDir) {
  if (fs.existsSync(path.join(targetDir, '.git'))) {
    run('git', ['pull', '--ff-only'], targetDir)
    return
  }
  run('git', ['clone', repoUrl, targetDir], '/')
  run('git', ['config', '--global', 'safe.directory', '*'], targetDir)
}

export function gitCommitAndPush(dir, message) {
  run('git', ['config', 'user.email', 'session-agent@allaria.xyz'], dir)
  run('git', ['config', 'user.name', 'Allaria Session Agent'], dir)

  const statusOut = spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf-8' })
  if (!statusOut.stdout.trim()) {
    return { pushed: false, message: 'Nada para commitear' }
  }

  run('git', ['add', '-A'], dir)
  run('git', ['commit', '-m', message], dir)
  run('git', ['push'], dir)

  const commit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: dir, encoding: 'utf-8' })
  return { pushed: true, commit: commit.stdout.trim() }
}

export function getChangedFiles(dir) {
  const result = spawnSync('git', ['diff', '--name-only', 'HEAD~1', 'HEAD'], {
    cwd: dir, encoding: 'utf-8',
  })
  return result.stdout.trim().split('\n').filter(Boolean)
}
