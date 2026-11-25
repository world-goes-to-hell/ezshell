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
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
public static class EzShellPointer {
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr LoadImage(IntPtr instance, string name, uint type, int cx, int cy, uint load);
  [DllImport("user32.dll", SetLastError = true)] static extern bool SetSystemCursor(IntPtr cursor, uint id);
  [DllImport("user32.dll")] static extern bool DestroyCursor(IntPtr cursor);
  [DllImport("user32.dll", SetLastError = true)] static extern bool SystemParametersInfo(uint action, uint param, IntPtr value, uint update);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
  [DllImport("shell32.dll")] static extern int SHQueryUserNotificationState(out int state);
  static readonly object OutputLock = new object();
  static bool Restore() { return SystemParametersInfo(0x57, 0, IntPtr.Zero, 0); }
  static void Write(string line) {
    lock (OutputLock) {
      Console.Out.WriteLine(line);
      Console.Out.Flush();
    }
  }
  static bool Down(int key) { return (GetAsyncKeyState(key) & 0x8000) != 0; }
  static void Watch(ManualResetEvent done) {
    var clock = Stopwatch.StartNew();
    long nextState = 0;
    int lastState = -1;
    bool left = Down(1), right = Down(2);
    try {
      do {
        if (clock.ElapsedMilliseconds >= nextState) {
          int state;
          if (SHQueryUserNotificationState(out state) != 0) state = 0;
          if (state != lastState) { Write("notification " + state); lastState = state; }
          nextState = clock.ElapsedMilliseconds + 2000;
        }
        bool newLeft = Down(1), newRight = Down(2);
        if (newLeft && !left) Write("press");
        if (newRight && !right) Write("press");
        left = newLeft;
        right = newRight;
      } while (!done.WaitOne(15));
    } catch (IOException) { /* the app's output pipe closed */ }
  }
  static void StopWatching(ref Thread watcher, ref ManualResetEvent done) {
    if (watcher == null) return;
    done.Set();
    if (watcher.Join(500)) done.Dispose();
    watcher = null;
    done = null;
  }
  // apply: "apply <state>=<id>,..." loads <folder>\\<state>.cur at its own size and puts it in place of <id>
  static string Apply(string folder, string list, ref bool replaced) {
    foreach (string item in list.Split(',')) {
      string[] pair = item.Split('=');
      uint id;
      if (pair.Length != 2 || pair[0].Length == 0 || pair[0].IndexOfAny(new char[] { '\\\\', '/', ':', '.' }) >= 0 || !UInt32.TryParse(pair[1], out id)) return "error bad";
      IntPtr cursor = LoadImage(IntPtr.Zero, Path.Combine(folder, pair[0] + ".cur"), 2, 0, 0, 0x10);
      if (cursor == IntPtr.Zero) return "error " + pair[0];
      // SetSystemCursor owns the handle when it succeeds
      if (!SetSystemCursor(cursor, id)) { DestroyCursor(cursor); return "error " + pair[0]; }
      replaced = true;
    }
    return "applied";
  }
  public static void Run(string folder) {
    bool replaced = File.Exists(Path.Combine(folder, "${MARKER}"));
    Thread watcher = null;
    ManualResetEvent done = null;
    Write("ready");
    string line;
    try {
      while ((line = Console.In.ReadLine()) != null) {
        if (line == "restore") {
          if (Restore()) { replaced = false; Write("restored"); }
          else Write("error restore");
        } else if (line.StartsWith("apply ")) Write(Apply(folder, line.Substring(6), ref replaced));
        else if (line == "watch on" && watcher == null) {
          done = new ManualResetEvent(false);
          var stopSignal = done;
          watcher = new Thread(() => Watch(stopSignal)) { IsBackground = true };
          watcher.Start();
        } else if (line == "watch off") StopWatching(ref watcher, ref done);
      }
    } finally {
      // The app went away (its end of the pipe closed): the user's own pointers come back
      StopWatching(ref watcher, ref done);
      if (replaced) Restore();
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
function createGlobalPointer({ folder, platform = process.platform, allowNative = true, spawn = spawnProcess, env = process.env, fsImpl = fs,
  onPress = () => {}, onNotificationState = () => {} }) {
  const supported = platform === 'win32'
  const sent = []
  let child = null
  let ready = false
  let closing = false
  let queue = []
  let restarts = 0
  let watching = false
  let stopped = false

  const marker = () => path.join(folder, MARKER)
  function launch() {
    if (child || stopped || !allowNative || !queue.length) return
    const powershell = `${env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    const proc = spawn(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(helperScript(folder), 'utf16le').toString('base64')], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'ignore']
    })
    child = proc
    ready = false
    let pending = ''
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', chunk => {
      if (child !== proc) return
      pending += chunk
      let end
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end).trim()
        pending = pending.slice(end + 1)
        if (line === 'ready') {
          ready = true
          restarts = 0
          if (!closing) {
            flushQueue(proc)
            closeIfIdle()
          }
        } else if (line.startsWith('error')) {
          console.error(`[globalPointer] ${line}`)
        } else if (watching) {
          const state = /^notification ([0-7])$/.exec(line)
          if (state) onNotificationState(Number(state[1]))
          else if (line === 'press') onPress()
        }
      }
      if (pending.length > 1024) pending = ''
    })
    proc.stdin.on('error', () => {})
    const disconnected = () => {
      if (child !== proc) return
      const wasClosing = closing
      child = null
      ready = false
      closing = false
      if (watching) {
        onNotificationState(null)
        queue = queue.filter(command => !command.startsWith('watch '))
        queue.push('watch on')
      }
      if (wasClosing) { launch(); return }
      // A failed start: a few more tries while there is still something to do
      if (queue.length && restarts++ < 3) setTimeout(launch, 2000 * restarts).unref?.()
      else queue = []
    }
    proc.on('error', disconnected)
    proc.on('exit', disconnected)
  }

  function send(command) {
    sent.push(command)
    if (!allowNative) return
    if (child && ready && !closing) child.stdin.write(command + '\n')
    else {
      queue.push(command)
      launch()
    }
  }

  function flushQueue(proc) {
    for (const command of queue) proc.stdin.write(command + '\n')
    queue = []
  }

  function closeIfIdle() {
    if (!child || closing || watching || fsImpl.existsSync(marker())) return
    closing = true
    // The pipe holds any commands queued while PowerShell was compiling the helper.
    flushQueue(child)
    child.stdin.end()
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
    if (!fsImpl.existsSync(marker())) return
    send('restore')
    try { fsImpl.rmSync(marker(), { force: true }) } catch { /* the helper still restores */ }
    closeIfIdle()
  }

  /** At start: pointers left replaced by a helper that was killed */
  function recover() {
    if (supported && fsImpl.existsSync(marker())) restore()
  }

  function setWatching(enabled) {
    if (!supported || stopped || enabled === watching) return
    watching = enabled
    // A not-yet-ready helper only needs the latest watch command.
    queue = queue.filter(command => !command.startsWith('watch '))
    if (enabled || (child && !closing) || !allowNative) send(enabled ? 'watch on' : 'watch off')
    if (!enabled) closeIfIdle()
  }

  /** App quit: the helper restores on the end of its input */
  function stop() {
    stopped = true
    watching = false
    queue = []
    if (!child || closing) return
    if (fsImpl.existsSync(marker()) && child.stdin.writable !== false) {
      // Send directly even during compilation. A helper still compiling may never read it (the app is
      // quitting), so its marker stays and the next start's recover() restores once more; a ready helper
      // already holds replaced=true and restores on the end of its input anyway.
      sent.push('restore')
      child.stdin.write('restore\n')
      if (ready) try { fsImpl.rmSync(marker(), { force: true }) } catch { /* next start retries */ }
    }
    child.stdin.end()
    child = null
  }

  return { apply, restore, recover, setWatching, stop, supported, sent }
}

module.exports = { createGlobalPointer, checkCursorSet, cursorFile, pngSize, helperScript, SYSTEM_CURSOR_IDS, HELPER_SOURCE }
