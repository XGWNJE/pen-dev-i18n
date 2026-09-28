import { spawn, execFileSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { portAlive } from './cdp.mjs'
import { sleep, waitFor } from './util.mjs'

export const IS_MAC = process.platform === 'darwin'
export const IS_WIN = process.platform === 'win32'

function runPowerShell(script, env = {}) {
  const encoded = Buffer.from(`$ProgressPreference = 'SilentlyContinue'; ${script}`, 'utf16le').toString('base64')
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    encoding: 'utf8', env: { ...process.env, ...env },
  })
}

/** Resolve the bundled Pen preset without storing a machine-specific path in Git. */
export function resolvePresetApp(preset, platform = process.platform, env = process.env) {
  if (platform !== 'win32') return preset.app
  if (env.PEN_APP_PATH && !fs.existsSync(env.PEN_APP_PATH)) {
    throw new Error(`PEN_APP_PATH 指向的文件不存在：${env.PEN_APP_PATH}`)
  }
  const candidates = [
    env.PEN_APP_PATH,
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'Pen', 'Pen.exe'),
    env.ProgramFiles && path.join(env.ProgramFiles, 'Pen', 'Pen.exe'),
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Pen', 'Pen.exe'),
  ].filter(Boolean)
  const appPath = candidates.find(p => fs.existsSync(p))
  if (!appPath) throw new Error('找不到 Pen.exe；请设置 PEN_APP_PATH 为 Pen.exe 的完整路径后重试')
  return { ...preset.app, path: appPath, processPattern: appPath }
}

export function appName(config) {
  return config.app.name || path.basename(config.app.path).replace(/\.app$/, '')
}

export function processPattern(config) {
  if (config.app.processPattern) return config.app.processPattern
  const p = config.app.path || ''
  if (IS_MAC) return path.join(p, 'Contents', 'MacOS', path.basename(p, '.app'))
  return path.basename(p)
}

/** List only processes running the configured executable, not other apps named Pen.exe. */
export function findPids(config) {
  const pattern = processPattern(config)
  try {
    if (IS_WIN) {
      const script = '$target = [System.IO.Path]::GetFullPath($env:ZH_PATCH_EXE); Get-Process -Name $env:ZH_PATCH_NAME -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $target } | ForEach-Object { $_.Id }'
      const out = runPowerShell(script, { ZH_PATCH_EXE: path.resolve(config.app.path), ZH_PATCH_NAME: path.parse(pattern).name })
      return out.split(/\r?\n/).map(s => Number(s.trim())).filter(Boolean)
    }
    const out = execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' })
    return out.split('\n').map(s => Number(s.trim())).filter(Boolean)
  } catch { return [] }
}

export function isRunning(config) { return findPids(config).length > 0 }

/** 该 App 是否已开启调试端口 */
export async function hasDebugPort(config) {
  return (await portAlive(config.debug.pagePort)) && (await portAlive(config.debug.inspectPort))
}

export function mainExecutable(appPath) {
  if (IS_MAC) {
    const name = path.basename(appPath, '.app')
    return path.join(appPath, 'Contents', 'MacOS', name)
  }
  return appPath
}

/** 以调试端口启动（macOS 用 open，保留正常窗口/权限行为） */
export function launch(config, { wait = true, timeout = 30000, debug = true } = {}) {
  const args = debug ? [`--remote-debugging-address=127.0.0.1`, `--remote-debugging-port=${config.debug.pagePort}`] : []
  if (debug && config.debug.inspectPort) args.push(`--inspect=127.0.0.1:${config.debug.inspectPort}`)
  const all = [...args, ...(config.app.launchArgs || [])]

  if (IS_MAC && config.app.path.endsWith('.app')) {
    const child = spawn('open', ['-a', config.app.path, '--args', ...all], { detached: true, stdio: 'ignore' })
    child.unref()
  } else {
    const exe = mainExecutable(config.app.path)
    if (!fs.existsSync(exe)) throw new Error(`找不到可执行文件：${exe}`)
    const child = spawn(exe, all, { detached: true, stdio: 'ignore' })
    child.unref()
  }
  if (!wait || !debug) return Promise.resolve(true)
  return waitFor(() => portAlive(config.debug.pagePort), { timeout })
}

export async function quit(config) {
  if (IS_MAC && config.app.path.endsWith('.app')) {
    const name = appName(config)
    try { execFileSync('osascript', ['-e', `quit app "${name}"`], { stdio: 'ignore' }) } catch {}
  } else if (IS_WIN) {
    const script = '$target = [System.IO.Path]::GetFullPath($env:ZH_PATCH_EXE); Get-Process -Name $env:ZH_PATCH_NAME -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $target -and $_.MainWindowHandle -ne 0 } | ForEach-Object { [void]$_.CloseMainWindow() }'
    runPowerShell(script, { ZH_PATCH_EXE: path.resolve(config.app.path), ZH_PATCH_NAME: path.parse(processPattern(config)).name })
  } else {
    for (const pid of findPids(config)) { try { process.kill(pid, 'SIGTERM') } catch {} }
  }
  return waitFor(() => findPids(config).length === 0, { timeout: 15000 })
}

export async function forceKill(config) {
  for (const pid of findPids(config)) { try { process.kill(pid, 'SIGKILL') } catch {} }
  await sleep(500)
}

/** 从路径里猜配置（init 用） */
export function detectApp(appPath) {
  const abs = path.resolve(appPath)
  let name = path.basename(abs).replace(/\.app$/, '')
  let processPattern = null
  let electron = false
  let dictHint = null

  if (IS_MAC && abs.endsWith('.app')) {
    processPattern = path.join(abs, 'Contents', 'MacOS', name)
    const res = path.join(abs, 'Contents', 'Resources')
    electron = fs.existsSync(path.join(res, 'app.asar')) || fs.existsSync(path.join(res, 'app'))
    const plist = path.join(abs, 'Contents', 'Info.plist')
    if (fs.existsSync(plist)) {
      try {
        const out = execFileSync('plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' })
        const info = JSON.parse(out)
        if (info.CFBundleName) name = info.CFBundleName
        if (info.CFBundleIdentifier) dictHint = String(info.CFBundleIdentifier).split('.').pop()
      } catch {}
    }
  } else {
    processPattern = abs
    electron = fs.existsSync(path.join(path.dirname(abs), 'resources', 'app.asar'))
  }
  return { appPath: abs, name, processPattern, electron, slug: (dictHint || name).toLowerCase().replace(/[^a-z0-9]+/g, '-') }
}
