// Windows: the app's pointer set in every program (설정 > 테마 > 포인터 모양 > 다른 프로그램에서도 쓰기).
//
// The window draws each pointer to a PNG (it has the SVGs and a canvas) and sends them here. This module checks
// them, writes .cur files (a PNG inside an icon directory) to its own folder, and a small helper (Windows
// PowerShell with C#) loads them with LoadImage and puts them in place with SetSystemCursor. Putting the
// system's pointers back is SystemParametersInfo(SPI_SETCURSORS): it reloads the user's pointer scheme, which
// this never writes (no registry). SetSystemCursor lasts until that call or the next sign-in.
//
// When this app ends in any way its pipe to the helper closes, and the helper puts the pointers back on that
// end of input. If the helper itself was killed, a marker file left in the folder makes the next start put
// them back. Design: docs/plan/2026-11-25-pointer-outside-app.md
const fs = require('node:fs')
const path = require('node:path')
const { spawn: spawnProcess } = require('node:child_process')

// The app's pointer states that have a system pointer (OCR_* ids). grab and grabbing have none.
const SYSTEM_CURSOR_IDS = Object.freeze({
  default: 32512, text: 32513, wait: 32514, crosshair: 32515,
  'col-resize': 32644, 'row-resize': 32645, 'not-allowed': 32648, pointer: 32649, progress: 32650
})
const SIZES = [32, 48, 64]
const MAX_PNG_BYTES = 256 * 1024
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const MARKER = 'applied'

/** Width and height from a PNG's IHDR, or null when it is not a PNG */
function pngSize(png) {
  if (!Buffer.isBuffer(png) || png.length < 24 || !png.subarray(0, 8).equals(PNG_SIGNATURE) || png.toString('latin1', 12, 16) !== 'IHDR') return null
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

/**
 * The window's request → checked cursors, or null. Request: { size, cursors: [{ state, png (base64), hotspot: [x, y] }] }.
 * Only known states, once each; a PNG of exactly that size; a hotspot inside it.
 */
function checkCursorSet(request) {
  if (!request || typeof request !== 'object' || !SIZES.includes(request.size) || !Array.isArray(request.cursors)) return null
  const { size, cursors } = request
  if (cursors.length < 1 || cursors.length > Object.keys(SYSTEM_CURSOR_IDS).length) return null
  const seen = new Set()
  const checked = []
  for (const cursor of cursors) {
    if (!cursor || typeof cursor !== 'object' || !Object.hasOwn(SYSTEM_CURSOR_IDS, cursor.state) || seen.has(cursor.state)) return null
    seen.add(cursor.state)
    if (typeof cursor.png !== 'string' || cursor.png.length > Math.ceil(MAX_PNG_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(cursor.png)) return null
    const png = Buffer.from(cursor.png, 'base64')
    const dimensions = pngSize(png)
    if (!dimensions || dimensions.width !== size || dimensions.height !== size) return null
    const [x, y] = Array.isArray(cursor.hotspot) ? cursor.hotspot : []
    if (![x, y].every(value => Number.isInteger(value) && value >= 0 && value < size)) return null
    checked.push({ state: cursor.state, png, hotspot: [x, y] })
  }
  return { size, cursors: checked }
}

/** A .cur file: an icon directory of type 2 (cursor) with one PNG entry and its hotspot */
function cursorFile(png, size, [x, y]) {
  const head = Buffer.alloc(22)
  head.writeUInt16LE(0, 0)
  head.writeUInt16LE(2, 2)
  head.writeUInt16LE(1, 4)
  head.writeUInt8(size, 6)
  head.writeUInt8(size, 7)
  head.writeUInt16LE(x, 10)
  head.writeUInt16LE(y, 12)
  head.writeUInt32LE(png.length, 14)
  head.writeUInt32LE(22, 18)
  return Buffer.concat([head, png])
}

const HELPER_SOURCE = `
using System;
using System.IO;
using System.Runtime.InteropServices;
public static class EzShellPointer {
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr LoadImage(IntPtr instance, string name, uint type, int cx, int cy, uint load);
  [DllImport("user32.dll", SetLastError = true)] static extern bool SetSystemCursor(IntPtr cursor, uint id);
  [DllImport("user32.dll")] static extern bool DestroyCursor(IntPtr cursor);
  [DllImport("user32.dll", SetLastError = true)] static extern bool SystemParametersInfo(uint action, uint param, IntPtr value, uint update);
  static void Restore() { SystemParametersInfo(0x57, 0, IntPtr.Zero, 0); }
  // apply: "apply <state>=<id>,..." loads <folder>\\<state>.cur at its own size and puts it in place of <id>
  static string Apply(string folder, string list) {
    foreach (string item in list.Split(',')) {
      string[] pair = item.Split('=');
      uint id;
      if (pair.Length != 2 || pair[0].Length == 0 || pair[0].IndexOfAny(new char[] { '\\\\', '/', ':', '.' }) >= 0 || !UInt32.TryParse(pair[1], out id)) return "error bad";
      IntPtr cursor = LoadImage(IntPtr.Zero, Path.Combine(folder, pair[0] + ".cur"), 2, 0, 0, 0x10);
      if (cursor == IntPtr.Zero) return "error " + pair[0];
      // SetSystemCursor owns the handle when it succeeds
      if (!SetSystemCursor(cursor, id)) { DestroyCursor(cursor); return "error " + pair[0]; }
    }
    return "applied";
  }
  public static void Run(string folder) {
    Console.Out.WriteLine("ready");
    Console.Out.Flush();
    string line;
    try {
      while ((line = Console.In.ReadLine()) != null) {
        if (line == "restore") { Restore(); Console.Out.WriteLine("restored"); }
        else if (line.StartsWith("apply ")) Console.Out.WriteLine(Apply(folder, line.Substring(6)));
        Console.Out.Flush();
      }
    } finally {
      // The app went away (its end of the pipe closed): the user's own pointers come back
      Restore();
    }
  }
}
`

/** The helper's PowerShell script: the C# source and the folder of the .cur files */
function helperScript(folder) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder) || /[\r\n\0]/.test(folder)) throw new Error('bad pointer folder')
  return `$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition @'\n${HELPER_SOURCE}\n'@\n[EzShellPointer]::Run('${folder.replace(/'/g, "''")}')\n`
}

/**
 * @param {object} deps
 * @param {string} deps.folder where the .cur files and the marker go (the app's user data)
 * @param {boolean} [deps.allowNative] false in screen tests: commands are kept in `sent`, nothing is started
 */
function createGlobalPointer({ folder, platform = process.platform, allowNative = true, spawn = spawnProcess, env = process.env, fsImpl = fs }) {
  const supported = platform === 'win32'
  const sent = []
  let child = null
  let ready = false
  let queue = []
  let restarts = 0

  const marker = () => path.join(folder, MARKER)
  function launch() {
    if (child || !allowNative) return
    const powershell = `${env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    const proc = spawn(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(helperScript(folder), 'utf16le').toString('base64')], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'ignore']
    })
    child = proc
    ready = false
    let pending = ''
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', chunk => {
      pending += chunk
      let end
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end).trim()
        pending = pending.slice(end + 1)
        if (line === 'ready') {
          ready = true
          restarts = 0
          for (const command of queue) proc.stdin.write(command + '\n')
          queue = []
        } else if (line.startsWith('error')) {
          console.error(`[globalPointer] ${line}`)
        }
      }
      if (pending.length > 1024) pending = ''
    })
    proc.on('error', () => {})
    proc.stdin.on('error', () => {})
    proc.on('exit', () => {
      if (child !== proc) return
      child = null
      ready = false
      // A failed start: a few more tries while there is still something to do
      if (queue.length && restarts++ < 3) setTimeout(launch, 2000 * restarts).unref?.()
      else queue = []
    })
  }

  function send(command) {
    sent.push(command)
    if (!allowNative) return
    if (child && ready) child.stdin.write(command + '\n')
    else {
      queue.push(command)
      launch()
    }
  }

  /** Puts the window's pointers in place of the system's. Returns false when the request is refused. */
  function apply(request) {
    if (!supported) return false
    const checked = checkCursorSet(request)
    if (!checked) return false
    fsImpl.mkdirSync(folder, { recursive: true })
    for (const { state, png, hotspot } of checked.cursors) {
      const file = path.join(folder, `${state}.cur`)
      fsImpl.writeFileSync(file + '.tmp', cursorFile(png, checked.size, hotspot))
      fsImpl.renameSync(file + '.tmp', file)
    }
    fsImpl.writeFileSync(marker(), '1')
    send('apply ' + checked.cursors.map(({ state }) => `${state}=${SYSTEM_CURSOR_IDS[state]}`).join(','))
    return true
  }

  /** The system's own pointers again (nothing to do if none were replaced) */
  function restore() {
    if (!supported) return
    const replaced = fsImpl.existsSync(marker())
    if (!replaced && !child) return
    send('restore')
    try { fsImpl.rmSync(marker(), { force: true }) } catch { /* the helper still restores */ }
  }

  /** At start: pointers left replaced by a helper that was killed */
  function recover() {
    if (supported && fsImpl.existsSync(marker())) restore()
  }

  /** App quit: the helper restores on the end of its input */
  function stop() {
    if (!child) return
    try { fsImpl.rmSync(marker(), { force: true }) } catch { /* next start retries */ }
    child.stdin.end()
    child = null
  }

  return { apply, restore, recover, stop, supported, sent }
}

module.exports = { createGlobalPointer, checkCursorSet, cursorFile, pngSize, helperScript, SYSTEM_CURSOR_IDS, HELPER_SOURCE }
