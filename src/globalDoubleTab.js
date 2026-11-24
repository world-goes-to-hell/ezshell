// The work overview shortcut (default Ctrl+Alt+Space, settings > 키보드 단축키) opens the overview even while
// another program is in front (user request, 2026-11-21; Tab Tab until 2026-11-24, when it was replaced: it
// fired on a shell's Tab Tab completion and took a Tab from editors). The window itself only hears keys while
// it has the focus, so a small helper (Windows PowerShell running C#) keeps a low-level keyboard hook:
// - main gives it the binding as two numbers (overview <modifier bits> <virtual key>, checked here by
//   overviewKeySpec and again by the helper); it tells main nothing but "overview" when that key is pressed
//   with exactly those modifiers (not a held key, not an injected one);
// - while ezShell's own window is in front it lets every key through: the window's handler does the rest
//   (Sidebar/WorkOverview.tsx);
// - otherwise the key (down, repeats, up) is kept from the program in front, and once every modifier is
//   released ezShell's window is brought forward (restored if minimized). Windows lets a process take the
//   foreground only right after input of its own, hence the Alt tap before SetForegroundWindow. With Alt in
//   the binding, a do-nothing key (vkE8, as AutoHotkey's menu mask) is sent at once, so releasing Alt does
//   not open the menu bar of the program in front.
// It also tells where the program in front was: "overview <x> <y>", the middle of that window in screen pixels
// (read before ezShell comes forward), so the overview opens on the monitor the user is working on
// (2026-11-22 user report: it opened on ezShell's monitor). Nothing else about that window.
// The same hook reports "capture" when Ctrl+Alt+Shift or Ctrl+Win+Alt is pressed and released.
// An unmodified Escape cancels an active capture whose overlay is outside the foreground.
// Off while the app is locked (`off` on its input), and it ends when main goes (its input closes).
// Windows only: elsewhere a global key watch needs a permission the user grants by hand.

const { spawn: spawnProcess } = require('child_process')

const MAX_RESTARTS = 3
// "overview", or "overview <x> <y>": where the window in front was (screen pixels)
const OVERVIEW_LINE = /^overview(?: (-?\d{1,6}) (-?\d{1,6}))?$/
const DEFAULT_OVERVIEW_KEYS = ['Ctrl', 'Alt', 'Space']
// Modifier bits as the helper counts them (Win is 2 and never part of the binding)
const MODIFIER_BITS = { ctrl: 1, control: 1, alt: 4, shift: 8 }
// Virtual keys of the keys a binding may end in (lib/shortcutCapture.ts names them), Tab left out
const NAMED_KEYS = {
  space: 0x20, pageup: 0x21, pagedown: 0x22, end: 0x23, home: 0x24,
  arrowleft: 0x25, arrowup: 0x26, arrowright: 0x27, arrowdown: 0x28, insert: 0x2d,
  ';': 0xba, '+': 0xbb, ',': 0xbc, '-': 0xbd, '.': 0xbe, '/': 0xbf, '`': 0xc0,
  '[': 0xdb, '\\': 0xdc, ']': 0xdd, "'": 0xde
}

/**
 * The binding (['Ctrl', 'Alt', 'Space']) as the helper's numbers, or null. The shortcut is taken from every
 * program and from the terminal, so it needs two or more of Ctrl, Alt and Shift, one of them Ctrl or Alt
 * (Ctrl+O or Alt+B alone would take a key every program and the shell's readline use).
 */
function overviewKeySpec(keys) {
  if (!Array.isArray(keys) || keys.length < 3 || keys.length > 4) return null
  let mods = 0
  let vk = 0
  // Checked in the loop: `every` skips the holes of a sparse list, which would reach toLowerCase as undefined
  for (const key of keys) {
    if (typeof key !== 'string' || key.length === 0 || key.length > 12) return null
    const name = key.toLowerCase()
    // Own names only: 'constructor' or '__proto__' must not read Object.prototype
    const bit = Object.hasOwn(MODIFIER_BITS, name) ? MODIFIER_BITS[name] : 0
    if (bit) {
      if (mods & bit) return null
      mods |= bit
      continue
    }
    if (vk) return null
    if (/^[a-z0-9]$/.test(name)) vk = name.toUpperCase().charCodeAt(0)
    else if (/^f([1-9]|1[0-9]|2[0-4])$/.test(name)) vk = 0x6f + Number(name.slice(1))
    else vk = Object.hasOwn(NAMED_KEYS, name) ? NAMED_KEYS[name] : 0
    if (!Number.isInteger(vk) || !vk) return null
  }
  const count = [1, 4, 8].filter(bit => mods & bit).length
  return vk && count >= 2 && (mods & 5) ? { mods, vk } : null
}

const HOOK_SOURCE = String.raw`
using System;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Threading;

public static class EzShellDoubleTab {
  delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] struct KeyInfo { public uint vk; public uint scan; public uint flags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int left; public int top; public int right; public int bottom; }
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
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

  static HookProc keep;
  static IntPtr hook;
  static uint appPid;
  static IntPtr appWindow;
  static volatile bool enabled = true;
  // The overview binding: modifier bits (Ctrl 1, Alt 4, Shift 8) and a virtual key; 0 is off
  static volatile int overviewMods = 5;
  static volatile int overviewVk = 0x20;
  // The binding's key is down in another program: its repeats and its release are kept from it too
  static uint overviewHeld;
  static long overviewHeldAt;
  // The window that was in front, while the overview waits for the modifiers to be released
  static long overviewFront;
  static long overviewFrontAt;
  static int modifiers;
  static bool captureArmed;
  static bool captureBlocked;
  static int captureState; // idle, started, cancelling
  static long captureWindow;
  static bool swallowEscapeUp;
  static readonly BlockingCollection<string> captureMessages = new BlockingCollection<string>();
  // Tests only (set by reflection): report without touching the desktop
  static bool dryRun = false;
  static readonly System.Diagnostics.Stopwatch clock = System.Diagnostics.Stopwatch.StartNew();

  public static void Run(uint pid, long window) {
    appPid = pid;
    appWindow = new IntPtr(window);
    keep = (code, wParam, lParam) => OnKey(code, wParam, lParam);
    hook = SetWindowsHookEx(13, keep, GetModuleHandle(null), 0);
    if (hook == IntPtr.Zero) { Console.Out.WriteLine("error"); Console.Out.Flush(); return; }
    var input = new Thread(() => {
      string line;
      while ((line = Console.In.ReadLine()) != null) {
        if (line == "on") enabled = true;
        else if (line == "off") { enabled = false; overviewHeld = 0; Interlocked.Exchange(ref overviewFront, 0); EndCapture(); }
        else if (line == "capture-end") EndCapture();
        else if (line.StartsWith("overview ", StringComparison.Ordinal)) SetOverview(line.Substring(9));
        else if (line.StartsWith("capture-focus ", StringComparison.Ordinal)) {
          long handle;
          if (long.TryParse(line.Substring(14), out handle) && handle > 0) FocusCapture(new IntPtr(handle));
        }
      }
      Environment.Exit(0);
    });
    input.IsBackground = true;
    input.Start();
    var captureOutput = new Thread(() => {
      foreach (string message in captureMessages.GetConsumingEnumerable()) {
        Console.Out.WriteLine(message);
        Console.Out.Flush();
      }
    });
    captureOutput.IsBackground = true;
    captureOutput.Start();
    Console.Out.WriteLine("ready");
    Console.Out.Flush();
    Msg msg;
    while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) { }
  }

  static bool Pressed(int vk) { return GetAsyncKeyState(vk) < 0; }

  // In WH_KEYBOARD_LL, GetAsyncKeyState still reflects the state before the current event.
  static bool PressedAfter(int vk, uint changed, bool down) { return vk == changed ? down : Pressed(vk); }
  static int ModifierMask(uint changed, bool down) {
    return (PressedAfter(0xA2, changed, down) || PressedAfter(0xA3, changed, down) ? 1 : 0)
      | (PressedAfter(0x5B, changed, down) || PressedAfter(0x5C, changed, down) ? 2 : 0)
      | (PressedAfter(0xA4, changed, down) || PressedAfter(0xA5, changed, down) ? 4 : 0)
      | (PressedAfter(0xA0, changed, down) || PressedAfter(0xA1, changed, down) ? 8 : 0);
  }

  static bool CaptureGesture(int held, bool modifier, bool down) {
    if (!enabled || held == 0) {
      bool fire = enabled && modifier && !down && captureArmed && !captureBlocked;
      captureArmed = false;
      captureBlocked = false;
      return fire;
    }
    // A fourth key makes this an ordinary Windows shortcut. Wait for all modifiers before rearming.
    if ((held & 10) == 10 || (!modifier && down)) captureBlocked = true;
    if ((held == 7 || held == 13) && modifier && down && !captureBlocked) captureArmed = true;
    return false;
  }

  // A virtual key the binding may use: space, page and arrow keys, insert, digits, letters, F1-F24, punctuation
  static bool OverviewKeyAllowed(int vk) {
    return vk == 0x20 || (vk >= 0x21 && vk <= 0x28) || vk == 0x2D || (vk >= 0x30 && vk <= 0x39) || (vk >= 0x41 && vk <= 0x5A)
      || (vk >= 0x70 && vk <= 0x87) || (vk >= 0xBA && vk <= 0xC0) || (vk >= 0xDB && vk <= 0xDE);
  }

  // "<mods> <vk>" from main, checked again: Ctrl 1, Alt 4, Shift 8 only, two or more with Ctrl or Alt. Anything else is off.
  static void SetOverview(string value) {
    int mods = 0, vk = 0;
    string[] parts = value.Split(' ');
    bool ok = parts.Length == 2 && int.TryParse(parts[0], out mods) && int.TryParse(parts[1], out vk)
      && (mods & ~13) == 0 && (mods & 5) != 0 && ((mods & 1) + ((mods >> 2) & 1) + ((mods >> 3) & 1)) >= 2 && OverviewKeyAllowed(vk);
    overviewMods = ok ? mods : 0;
    overviewVk = ok ? vk : 0;
    overviewHeld = 0;
    Interlocked.Exchange(ref overviewFront, 0);
  }

  // Whether an event of the held key is kept from the program in front: its repeats and its release, but not a
  // new press after a missed release (no event for 1.5 seconds, longer than the longest key repeat delay: a
  // secure desktop such as Win+L or UAC took the release)
  static bool KeepHeldKey(bool down, bool up, long now) {
    if (down && now - overviewHeldAt > 1500) { overviewHeld = 0; return false; }
    overviewHeldAt = now;
    if (up) overviewHeld = 0;
    return true;
  }

  // A chord still waiting for its modifiers after 5 seconds (a release missed the same way) does not bring
  // ezShell forward later, on some unrelated modifier release
  static bool FrontStillWaiting(long now) {
    return now - Interlocked.Read(ref overviewFrontAt) <= 5000;
  }

  // The binding's key pressed with exactly its modifiers
  static bool IsOverviewChord(uint vk, int held) {
    int key = overviewVk;
    return key != 0 && vk == (uint)key && held == overviewMods;
  }

  static bool AppInFront() {
    uint pid;
    GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    return pid == appPid;
  }

  static bool CaptureEscape(bool down, bool up, IntPtr foreground) {
    long window = Interlocked.Read(ref captureWindow);
    if (down && enabled && modifiers == 0 && (window == 0 || foreground.ToInt64() != window)
        && Interlocked.CompareExchange(ref captureState, 2, 1) == 1) {
      swallowEscapeUp = true;
      captureMessages.Add("capture-cancel");
    }
    if (!swallowEscapeUp) return false;
    if (up) swallowEscapeUp = false;
    return true;
  }

  static IntPtr OnKey(int code, IntPtr wParam, IntPtr lParam) {
    if (code < 0) return CallNextHookEx(hook, code, wParam, lParam);
    var key = (KeyInfo)Marshal.PtrToStructure(lParam, typeof(KeyInfo));
    int message = wParam.ToInt32();
    bool down = message == 0x100 || message == 0x104;
    bool up = message == 0x101 || message == 0x105;
    // Injected keys (automation, our own Alt tap and menu mask) never count
    if ((key.flags & 0x10) != 0) return CallNextHookEx(hook, code, wParam, lParam);
    if (down || up) {
      bool modifierKey = key.vk == 0x5B || key.vk == 0x5C || (key.vk >= 0xA0 && key.vk <= 0xA5);
      if (modifierKey) modifiers = ModifierMask(key.vk, down);
      if (CaptureGesture(modifiers, modifierKey, down) && Interlocked.CompareExchange(ref captureState, 1, 0) == 0)
        captureMessages.Add("capture");
      // Every modifier is up again: now the overview may come forward
      if (modifierKey && modifiers == 0) {
        long front = Interlocked.Exchange(ref overviewFront, 0);
        if (front != 0 && FrontStillWaiting(clock.ElapsedMilliseconds)) ThreadPool.QueueUserWorkItem(_ => BringForward(new IntPtr(front)));
      }
    }
    if (key.vk == 0x1B && CaptureEscape(down, up, GetForegroundWindow())) return new IntPtr(1);
    if (overviewHeld != 0 && key.vk == overviewHeld && KeepHeldKey(down, up, clock.ElapsedMilliseconds)) return new IntPtr(1);
    if (!down || !enabled || !IsOverviewChord(key.vk, modifiers) || AppInFront()) return CallNextHookEx(hook, code, wParam, lParam);
    long now = clock.ElapsedMilliseconds;
    overviewHeld = key.vk;
    overviewHeldAt = now;
    // Keep the program in front from opening its menu bar when Alt is released
    if ((modifiers & 4) != 0 && !dryRun) { keybd_event(0xE8, 0, 0, UIntPtr.Zero); keybd_event(0xE8, 0, 2, UIntPtr.Zero); }
    if (Interlocked.CompareExchange(ref overviewFront, Math.Max(1, GetForegroundWindow().ToInt64()), 0) == 0)
      Interlocked.Exchange(ref overviewFrontAt, now);
    return new IntPtr(1);
  }

  static void EndCapture() {
    Interlocked.Exchange(ref captureState, 0);
    Interlocked.Exchange(ref captureWindow, 0);
  }

  static void FocusCapture(IntPtr window) {
    if (!enabled || Volatile.Read(ref captureState) != 1) return;
    uint pid;
    GetWindowThreadProcessId(window, out pid);
    if (pid != appPid) return;
    Interlocked.Exchange(ref captureWindow, window.ToInt64());
    if (GetForegroundWindow() == window || !IsWindowVisible(window) || SetForegroundWindow(window)) return;
    if (!Pressed(0x10) && !Pressed(0x11) && !Pressed(0x12) && !Pressed(0x5B) && !Pressed(0x5C)) {
      TapAlt();
      if (Volatile.Read(ref captureState) == 1) SetForegroundWindow(window);
    }
  }

  static void TapAlt() {
    keybd_event(0x12, 0, 0, UIntPtr.Zero);
    keybd_event(0x12, 0, 2, UIntPtr.Zero);
  }

  // The middle of the window that was in front, in physical screen pixels (main turns them into its own)
  static string Where(IntPtr front) {
    try { SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch (Exception) { }
    Rect rect;
    if (front == IntPtr.Zero || !GetWindowRect(front, out rect) || rect.right <= rect.left || rect.bottom <= rect.top) return "";
    return " " + ((rect.left + rect.right) / 2) + " " + ((rect.top + rect.bottom) / 2);
  }

  static void BringForward(IntPtr front) {
    if (!enabled) return;
    string where = Where(front);
    if (!dryRun) {
      if (IsIconic(appWindow)) ShowWindow(appWindow, 9);
      TapAlt();
      SetForegroundWindow(appWindow);
    }
    captureMessages.Add("overview" + where);
  }
}
`

/** The helper's PowerShell script: the hook's source and the window to bring forward (numbers only) */
function helperScript(pid, windowHandle) {
  if (![pid, windowHandle].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('bad helper arguments')
  // Without comment lines and indentation: the script goes on PowerShell's command line (-EncodedCommand, UTF-16
  // in base64), which Windows cuts at 32767 characters. The full source took 29,000 of them in 2026-11.
  const source = HOOK_SOURCE.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('//')).join('\n')
  return `$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition @'\n${source}\n'@\n[EzShellDoubleTab]::Run(${pid}, ${windowHandle})\n`
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
 * @param {(point: { x: number, y: number } | null) => void} deps.onOverview the overview shortcut while another
 *   program was in front (ezShell is in front now), with the middle of that program's window in screen pixels
 */
function createGlobalDoubleTab({ onOverview, onCapture = () => {}, onCaptureCancel = () => {}, platform = process.platform, spawn = spawnProcess, env = process.env }) {
  let child = null
  let enabled = false
  // What the helper is told about the overview shortcut: two numbers, or 0 0 (off)
  let overviewLine = overviewLineOf(DEFAULT_OVERVIEW_KEYS)
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
          send(overviewLine)
        } else if (enabled) {
          if (line === 'capture') {
            onCapture()
            continue
          }
          if (line === 'capture-cancel') {
            onCaptureCancel()
            continue
          }
          const overview = OVERVIEW_LINE.exec(line)
          if (overview) onOverview(overview[1] === undefined ? null : { x: Number(overview[1]), y: Number(overview[2]) })
        }
      }
      if (pending.length > 1024) pending = ''
    })
    proc.on('error', () => {})
    proc.stdin.on('error', () => {})
    proc.on('exit', () => {
      if (child !== proc) return
      child = null
      // A crash or a failed start: a few more tries, then the window's own shortcut only
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
    /** The overview binding from the window's settings; one the rules refuse turns it off outside the window */
    setOverviewKey(keys) {
      overviewLine = overviewLineOf(keys)
      send(overviewLine)
    },
    focusCapture(windowHandleBuffer) {
      const windowHandle = handleNumber(windowHandleBuffer)
      if (enabled && windowHandle) send(`capture-focus ${windowHandle}`)
    },
    endCapture() {
      send('capture-end')
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

function overviewLineOf(keys) {
  const spec = overviewKeySpec(keys)
  return spec ? `overview ${spec.mods} ${spec.vk}` : 'overview 0 0'
}

module.exports = { createGlobalDoubleTab, helperScript, handleNumber, overviewKeySpec }
