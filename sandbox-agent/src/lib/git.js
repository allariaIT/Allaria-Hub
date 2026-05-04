import { execSync } from 'node:child_process'

function run(cmd, cwd) {
  return execSync(cmd, { cwd, stdio: 'pipe' }).toString().trim()
}

export function gitInit(projectDir, repoUrl) {
  run('git init', projectDir)
  run('git checkout -b main', projectDir)
  if (repoUrl) {
    run(`git remote add origin ${repoUrl}`, projectDir)
  }
}

export function gitCommitAndPush(projectDir, message) {
  run('git add -A', projectDir)
  try {
    run(`git commit -m "${message.replace(/"/g, '\\"')}"`, projectDir)
  } catch {
    return { pushed: false, message: 'Nada para commitear' }
  }
  try {
    run('git push -u origin main', projectDir)
    return { pushed: true }
  } catch (err) {
    return { pushed: false, message: err.message }
  }
}
