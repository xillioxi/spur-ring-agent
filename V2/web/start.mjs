import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

function versionOf(binary) {
  const result = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 3000 })
  const match = result.status === 0 ? (result.stdout || '').match(/v?(\d+)\.(\d+)\.(\d+)/) : null
  return match ? match.slice(1).map(Number) : null
}

function supportsWebProxy(version) {
  if (!version) return false
  const [major, minor] = version
  return major > 24 || (major === 24 && minor >= 5) || (major === 22 && minor >= 21)
}

function candidates() {
  const home = homedir()
  const result = [process.env.SPUR_NODE_BIN, process.execPath]
  for (const root of [join(home, '.nvm/versions/node'), join(home, '.local/share/mise/installs/node')]) {
    if (!existsSync(root)) continue
    try {
      for (const name of readdirSync(root).sort().reverse()) result.push(join(root, name, 'bin/node'))
    } catch {}
  }
  result.push('/opt/homebrew/bin/node', '/usr/local/bin/node')
  const codexRuntimeRoot = join(home, '.cache/codex-runtimes')
  if (existsSync(codexRuntimeRoot)) {
    try {
      for (const name of readdirSync(codexRuntimeRoot)) result.push(join(codexRuntimeRoot, name, 'dependencies/node/bin/node'))
    } catch {}
  }
  return [...new Set(result.filter((candidate) => candidate && existsSync(candidate)))]
}

function macSystemProxy() {
  if (process.platform !== 'darwin') return null
  const result = spawnSync('scutil', ['--proxy'], { encoding: 'utf8', timeout: 3000 })
  const output = result.status === 0 ? result.stdout || '' : ''
  const value = (key) => output.match(new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, 'm'))?.[1]?.trim()
  const httpsEnabled = value('HTTPSEnable') === '1'
  const httpEnabled = value('HTTPEnable') === '1'
  const host = httpsEnabled ? value('HTTPSProxy') : httpEnabled ? value('HTTPProxy') : null
  const port = httpsEnabled ? value('HTTPSPort') : httpEnabled ? value('HTTPPort') : null
  return host && port ? `http://${host}:${port}` : null
}

const available = candidates().map((binary) => ({ binary, version: versionOf(binary) }))
const node = available.find(({ version }) => version && (version[0] > 22 || (version[0] === 22 && version[1] >= 19)))
  || available[0]
if (!node) throw new Error('找不到可用的 Node.js。')

const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || macSystemProxy()
const env = { ...process.env }
const localBusinessPython = fileURLToPath(new URL(
  process.platform === 'win32' ? './.venv/Scripts/python.exe' : './.venv/bin/python',
  import.meta.url,
))
if (!env.SPUR_BUSINESS_PYTHON && existsSync(localBusinessPython)) {
  env.SPUR_BUSINESS_PYTHON = localBusinessPython
}
if (proxy) {
  env.HTTPS_PROXY ||= proxy
  env.HTTP_PROXY ||= proxy
  env.NO_PROXY ||= 'localhost,127.0.0.1,::1'
}

const args = []
if (proxy && supportsWebProxy(node.version)) args.push('--use-env-proxy')
args.push(fileURLToPath(new URL('./server.mjs', import.meta.url)))

const child = spawn(node.binary, args, { stdio: 'inherit', env })
const pidFile = new URL('./.runtime/server.pid', import.meta.url)
mkdirSync(new URL('./.runtime/', import.meta.url), { recursive: true })
writeFileSync(pidFile, `${child.pid}\n`, { mode: 0o600 })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.on('error', (error) => {
  console.error(`无法启动 Spur 网页服务：${error.message}`)
  process.exitCode = 1
})
child.on('exit', (code, signal) => {
  try {
    if (readFileSync(pidFile, 'utf8').trim() === String(child.pid)) unlinkSync(pidFile)
  } catch {}
  process.exitCode = code ?? (signal ? 1 : 0)
})
