import { execSync, spawnSync } from 'node:child_process'

function run(cmd, cwd) {
  return execSync(cmd, { cwd, stdio: 'pipe', timeout: 30000 }).toString().trim()
}

export function gitInit(projectDir, repoUrl) {
  run('git init', projectDir)
  run('git checkout -b main', projectDir)
  if (repoUrl) {
    run(`git remote add origin ${repoUrl}`, projectDir)
  }
}

export function gitCommitAndPush(projectDir, message, pushUrl) {
  run('git add -A', projectDir)
  // Usar spawnSync con array de args para evitar inyección de shell
  const commitResult = spawnSync('git', ['commit', '-m', message], {
    cwd: projectDir,
    stdio: 'pipe',
    timeout: 30000,
    encoding: 'utf-8',
  })
  if (commitResult.status !== 0) {
    return { pushed: false, message: 'Nada para commitear' }
  }
  try {
    if (pushUrl) {
      // Usar spawnSync para no exponer el token en el proceso
      const pushResult = spawnSync('git', ['push', pushUrl, 'HEAD:main'], {
        cwd: projectDir,
        stdio: 'pipe',
        timeout: 30000,
        encoding: 'utf-8',
      })
      if (pushResult.status !== 0) {
        throw new Error(pushResult.stderr || 'git push falló')
      }
    } else {
      run('git push -u origin main', projectDir)
    }
    return { pushed: true }
  } catch (err) {
    return { pushed: false, message: err.message }
  }
}
