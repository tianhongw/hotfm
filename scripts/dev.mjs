import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const mode = process.argv[2] ?? 'all'
if (!['all', 'api', 'web'].includes(mode)) {
  console.error('Usage: node scripts/dev.mjs [api|web]')
  process.exit(1)
}

const children = new Set()
let stopping = false
let shutdownTimer
let buildDir

function sendSignal(child, signal, group = false) {
  if (!child.pid) return
  try {
    process.kill(group ? -child.pid : child.pid, signal)
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}

function stop(code = 0) {
  if (stopping) return
  stopping = true
  process.exitCode = code
  console.log('\nStopping HotFM…')
  // Let Vite finish pending transforms before it shuts down esbuild.
  for (const { child, groupShutdown } of children) sendSignal(child, 'SIGTERM', groupShutdown)
  // Give the API's five-second graceful shutdown time to finish.
  shutdownTimer = setTimeout(() => {
    for (const { child } of children) sendSignal(child, 'SIGKILL', true)
  }, 6500)
  shutdownTimer.unref()
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => stop())
}

function start(name, command, args, cwd, { env = process.env, groupShutdown = false } = {}) {
  const child = spawn(command, args, {
    cwd, env,
    // Only this supervisor handles terminal signals. Avoid pnpm/go-run
    // wrappers so ordinary shutdown does not print lifecycle failures.
    detached: true,
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  const service = { child, groupShutdown, done: null }
  service.done = new Promise((resolve) => {
    child.once('error', (error) => {
      if (!stopping) console.error(`${name}: ${error.message}`)
    })
    child.once('close', (code, signal) => {
      children.delete(service)
      resolve({ name, code: code > 0 ? code : 1, status: signal ?? code })
    })
  })
  children.add(service)
  return service.done
}

try {
  const services = []
  if (mode !== 'web') {
    buildDir = mkdtempSync(join(tmpdir(), 'hotfm-dev-'))
    const binary = join(buildDir, 'hotfm')
    console.log('Building HotFM API…')
    const build = await start('API build', 'go', ['build', '-o', binary, './cmd/hotfm'], join(root, 'server'), {
      groupShutdown: true, // Stop compiler workers too if interrupted during build.
    })
    if (!stopping && build.status !== 0) stop(build.code)
    if (!stopping) {
      services.push(start('API', binary, [], join(root, 'server'), {
        env: {
          ...process.env,
          HOTFM_DEV_CORS: '1',
          HOTFM_DATA_DIR: process.env.HOTFM_DATA_DIR || join(root, 'data'),
        },
      }))
    }
  }
  if (!stopping && mode !== 'api') {
    services.push(start('Vite', process.execPath, ['node_modules/vite/bin/vite.js'], join(root, 'web')))
  }
  if (services.length) {
    const result = await Promise.race(services)
    if (!stopping) {
      console.error(`${result.name} exited unexpectedly (${result.status}).`)
      stop(result.code)
    }
  }
} catch (error) {
  if (!stopping) console.error(error)
  stop(1)
} finally {
  await Promise.all([...children].map(({ done }) => done))
  clearTimeout(shutdownTimer)
  if (buildDir) rmSync(buildDir, { recursive: true, force: true })
}
