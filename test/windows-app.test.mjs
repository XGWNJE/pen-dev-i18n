import test from 'node:test'
import assert from 'node:assert/strict'
import { findPids, resolvePresetApp } from '../src/app.mjs'

const preset = { app: { path: '/Applications/Pen.app', processPattern: '/Applications/Pen.app/Contents/MacOS/Pen' } }

test('the Windows preset uses an explicit executable path', () => {
  const app = resolvePresetApp(preset, 'win32', { PEN_APP_PATH: process.execPath })
  assert.equal(app.path, process.execPath)
  assert.equal(app.processPattern, process.execPath)
  assert.equal(resolvePresetApp(preset, 'darwin').path, preset.app.path)
  assert.throws(() => resolvePresetApp(preset, 'win32', { PEN_APP_PATH: process.execPath + '.missing' }), /PEN_APP_PATH/)
})

test('Windows process detection filters by executable path', { skip: process.platform !== 'win32' }, () => {
  const config = { app: { path: process.execPath, processPattern: process.execPath } }
  assert.ok(findPids(config).includes(process.pid))
  assert.deepEqual(findPids({ app: { path: process.execPath + '.missing', processPattern: process.execPath } }), [])
})
