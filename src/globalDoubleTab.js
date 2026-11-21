// Tab pressed twice opens the work overview even while another program is in front (user request,
// 2026-11-21: "ezShell 만 켜져 있다면 다른 작업 중일 때도"). The window itself only hears keys while it has
// the focus, so a small helper (Windows PowerShell running C#) keeps a low-level keyboard hook:
// - it looks at the Tab key only and tells main nothing but "double" (two Tabs within DOUBLE_TAB_MS, no
//   modifier, no key between them, not a held key, not an injected one);
// - while ezShell's own window is in front it lets every key through: the window's handler does the rest
//   (Sidebar/WorkOverview.tsx);
// - otherwise the second Tab is kept from the program in front (the first one reached it already) and
//   ezShell's window is brought forward (restored if minimized). Windows lets a process take the
//   foreground only right after input of its own, hence the Alt tap before SetForegroundWindow.
// Off while the app is locked (`off` on its input), and it ends when main goes (its input closes).
// Windows only: elsewhere a global key watch needs a permission the user grants by hand.

const { spawn: spawnProcess } = require('child_process')

const DOUBLE_TAB_MS = 320
const MAX_RESTARTS = 3

const HOOK_SOURCE = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Threading;

public static class EzShellDoubleTab {
  delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] struct KeyInfo { public uint vk; public uint scan; public uint flags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct Msg { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int id, HookProc proc, IntPtr module, uint thread);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] static extern int GetMessage(out Msg msg, IntPtr hwnd, uint min, uint max);
  [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int command);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

  static HookProc keep;
  static IntPtr hook;
  static uint appPid;
  static IntPtr appWindow;
  static volatile bool enabled = true;
  static long lastTab = -1;
  static bool tabDown;
  static bool swallowUp;
  // Tests only (set by reflection): report without touching the desktop
  static bool dryRun = false;
  static readonly System.Diagnostics.Stopwatch clock = System.Diagnostics.Stopwatch.StartNew();

  public static void Run(uint pid, long window, int doubleMs) {
    appPid = pid;
    appWindow = new IntPtr(window);
    keep = (code, wParam, lParam) => OnKey(code, wParam, lParam, doubleMs);
    hook = SetWindowsHookEx(13, keep, GetModuleHandle(null), 0);
    if (hook == IntPtr.Zero) { Console.Out.WriteLine("error"); Console.Out.Flush(); return; }
    var input = new Thread(() => {
      string line;
      while ((line = Console.In.ReadLine()) != null) {
        if (line == "on") enabled = true;
        else if (line == "off") { enabled = false; lastTab = -1; }
      }
      Environment.Exit(0);
    });
    input.IsBackground = true;
    input.Start();
    Console.Out.WriteLine("ready");
    Console.Out.Flush();
    Msg msg;
    while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) { }
  }

  static bool Pressed(int vk) { return GetAsyncKeyState(vk) < 0; }

  static bool AppInFront() {
    uint pid;
    GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    return pid == appPid;
  }

  static IntPtr OnKey(int code, IntPtr wParam, IntPtr lParam, int doubleMs) {
    if (code < 0) return CallNextHookEx(hook, code, wParam, lParam);
    var key = (KeyInfo)Marshal.PtrToStructure(lParam, typeof(KeyInfo));
    int message = wParam.ToInt32();
    bool down = message == 0x100 || message == 0x104;
    bool up = message == 0x101 || message == 0x105;
    // Injected keys (automation, our own Alt tap) never count
    if ((key.flags & 0x10) != 0) return CallNextHookEx(hook, code, wParam, lParam);
    if (key.vk != 9) {
      if (down) lastTab = -1;
      return CallNextHookEx(hook, code, wParam, lParam);
    }
    if (up) {
      tabDown = false;
      if (swallowUp) { swallowUp = false; return new IntPtr(1); }
      return CallNextHookEx(hook, code, wParam, lParam);
    }
    if (!down) return CallNextHookEx(hook, code, wParam, lParam);
    // A held Tab repeats its key down: not a second press
    if (tabDown) { lastTab = -1; return CallNextHookEx(hook, code, wParam, lParam); }
    tabDown = true;
    bool modifier = Pressed(0x10) || Pressed(0x11) || Pressed(0x12) || Pressed(0x5B) || Pressed(0x5C);
    if (!enabled || modifier || AppInFront()) { lastTab = -1; return CallNextHookEx(hook, code, wParam, lParam); }
    long now = clock.ElapsedMilliseconds;
    if (lastTab >= 0 && now - lastTab <= doubleMs) {
      lastTab = -1;
      swallowUp = true;
      ThreadPool.QueueUserWorkItem(_ => BringForward());
      return new IntPtr(1);
    }
    lastTab = now;
    return CallNextHookEx(hook, code, wParam, lParam);
  }

  static void BringForward() {
    if (dryRun) { Console.Out.WriteLine("double"); Console.Out.Flush(); return; }
    if (IsIconic(appWindow)) ShowWindow(appWindow, 9);
    keybd_event(0x12, 0, 0, UIntPtr.Zero);
    keybd_event(0x12, 0, 2, UIntPtr.Zero);
    SetForegroundWindow(appWindow);
    Console.Out.WriteLine("double");
    Console.Out.Flush();
  }
}
`

/** The helper's PowerShell script: the hook's source and the window to bring forward (numbers only) */
function helperScript(pid, windowHandle, doubleMs = DOUBLE_TAB_MS) {
  if (![pid, windowHandle, doubleMs].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('bad helper arguments')
  return `$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition @'\n${HOOK_SOURCE.trim()}\n'@\n[EzShellDoubleTab]::Run(${pid}, ${windowHandle}, ${doubleMs})\n`
}

/** The native window handle Electron gives (a pointer-sized buffer) as a number */
function handleNumber(buffer) {
  if (!Buffer.isBuffer(buffer)) return 0
  if (buffer.length >= 8) {
    const value = buffer.readBigUInt64LE(0)
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : 0
  }
  return buffer.length >= 4 ? buffer.readUInt32LE(0) : 0
}

/**
 * @param {object} deps
 * @param {() => void} deps.onDoubleTab two Tabs while another program was in front (ezShell is in front now)
 */
function createGlobalDoubleTab({ onDoubleTab, platform = process.platform, spawn = spawnProcess, env = process.env }) {
  let child = null
  let enabled = false
  let restarts = 0
  let target = null
  let stopped = false

  function launch() {
    if (!target || stopped) return
    const script = helperScript(target.pid, target.windowHandle)
    const powershell = `${env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    const proc = spawn(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'ignore']
    })
    child = proc
    let pending = ''
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', chunk => {
      pending += chunk
      let end
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end).trim()
        pending = pending.slice(end + 1)
        if (line === 'ready') {
          restarts = 0
          send(enabled ? 'on' : 'off')
        } else if (line === 'double' && enabled) {
          onDoubleTab()
        }
      }
      if (pending.length > 1024) pending = ''
    })
    proc.on('error', () => {})
    proc.stdin.on('error', () => {})
    proc.on('exit', () => {
      if (child !== proc) return
      child = null
      // A crash or a failed start: a few more tries, then the window's own Tab Tab only
      if (!stopped && restarts < MAX_RESTARTS) {
        restarts += 1
        setTimeout(launch, 2000 * restarts).unref?.()
      }
    })
  }

  function send(line) {
    try { child?.stdin.write(line + '\n') } catch { /* gone: restarted on exit */ }
  }

  return {
    /** Starts watching for the window of this process (the main window's native handle) */
    start(windowHandleBuffer, pid = process.pid) {
      if (platform !== 'win32' || child) return false
      const windowHandle = handleNumber(windowHandleBuffer)
      if (!windowHandle) return false
      target = { pid, windowHandle }
      stopped = false
      launch()
      return true
    },
    /** On while the app is unlocked: off, every key goes through untouched */
    setEnabled(value) {
      if (enabled === Boolean(value)) return
      enabled = Boolean(value)
      send(enabled ? 'on' : 'off')
    },
    stop() {
      stopped = true
      const proc = child
      child = null
      try { proc?.stdin.end() } catch { /* already closed */ }
      try { proc?.kill() } catch { /* already gone */ }
    }
  }
}

module.exports = { createGlobalDoubleTab, helperScript, handleNumber, DOUBLE_TAB_MS }
