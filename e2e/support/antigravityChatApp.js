const { app } = require('electron')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const pty = require('node-pty')

const profile = app.commandLine.getSwitchValue('user-data-dir')
const home = path.join(profile, 'agy-home')
const bin = path.join(profile, 'bin')
const settings = path.join(home, '.gemini', 'antigravity-cli')
fs.mkdirSync(bin, { recursive: true })
fs.mkdirSync(settings, { recursive: true })
fs.writeFileSync(path.join(settings, 'settings.json'), JSON.stringify({
  statusLine: { type: 'command', command: 'echo fixture-original-status', padding: 1, stack_with_default: true }
}))

// The fake agy.exe draws through a JS child and starts the real status command itself.
// This reproduces the CLI → cmd.exe → reporter ancestry checked by main.
const source = path.join(bin, 'AgyFixture.cs')
const executable = path.join(bin, 'agy.exe')
fs.writeFileSync(source, `using System;
using System.Diagnostics;
using System.IO;
using System.Text;
class AgyFixture {
    static void Report(string prefix, string request, string result) {
        var command = File.ReadAllText(prefix + "status-command");
        var options = new ProcessStartInfo(Environment.GetEnvironmentVariable("ComSpec"), "/d /c " + command);
        options.UseShellExecute = false;
        options.CreateNoWindow = true;
        options.RedirectStandardInput = true;
        options.RedirectStandardOutput = true;
        options.RedirectStandardError = true;
        using (var reporter = Process.Start(options)) {
            var payload = new UTF8Encoding(false).GetBytes(File.ReadAllText(request));
            reporter.StandardInput.BaseStream.Write(payload, 0, payload.Length);
            reporter.StandardInput.Close();
            var output = reporter.StandardOutput.ReadToEnd().Trim();
            var errors = reporter.StandardError.ReadToEnd().Trim();
            reporter.WaitForExit();
            File.WriteAllLines(result + ".tmp", new [] { reporter.ExitCode.ToString(), output, errors });
            File.Move(result + ".tmp", result);
        }
    }

    static int Main(string[] args) {
        string profile = Environment.GetEnvironmentVariable("EZSHELL_TEST_AGY_PROFILE");
        string prefix = Path.Combine(profile, Environment.GetEnvironmentVariable("EZSHELL_TEST_AGY_PANE") + "-agy-");
        bool legacy = File.Exists(Path.Combine(profile, "agy-legacy"));
        if (args.Length == 1 && args[0] == "--help") {
            File.AppendAllText(prefix + "help", "probe" + Environment.NewLine);
            Console.WriteLine(legacy ? "  --settings-file string" : "  -s, --settings string");
            return 0;
        }
        if (legacy) {
            if (Array.IndexOf(args, "--settings") >= 0) {
                Console.Error.WriteLine("flags provided but not defined: -settings");
                return 2;
            }
            File.AppendAllText(prefix + "legacy-args", string.Join("|", args) + Environment.NewLine);
            Console.WriteLine("Legacy Antigravity started");
            return 0;
        }
        if (args.Length < 2 || args[0] != "--settings") return 2;
        var options = new ProcessStartInfo();
        options.FileName = Environment.GetEnvironmentVariable("EZSHELL_TEST_AGY_ELECTRON");
        options.Arguments = "\\\"" + Environment.GetEnvironmentVariable("EZSHELL_TEST_AGY_SCRIPT") + "\\\"";
        options.UseShellExecute = false;
        options.EnvironmentVariables["ELECTRON_RUN_AS_NODE"] = "1";
        options.EnvironmentVariables["EZSHELL_TEST_AGY_SETTINGS"] = args[1];
        using (var child = Process.Start(options)) {
            int sequence = 1;
            while (!child.WaitForExit(25)) {
                var request = prefix + "status-request-" + sequence;
                if (!File.Exists(request)) continue;
                Report(prefix, request, prefix + "status-result-" + sequence);
                sequence++;
            }
            return child.ExitCode;
        }
    }
}`)
const quote = value => `'${value.replace(/'/g, "''")}'`
const compile = `Add-Type -Path ${quote(source)} -OutputAssembly ${quote(executable)} -OutputType ConsoleApplication -ErrorAction Stop`
execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(compile, 'utf16le').toString('base64')], { windowsHide: true })
Object.assign(process.env, {
  USERPROFILE: home,
  PSModuleAnalysisCachePath: path.join(profile, 'PSModuleAnalysisCache'),
  Path: bin + path.delimiter + process.env.Path,
  EZSHELL_TEST_AGY_ELECTRON: process.execPath,
  EZSHELL_TEST_AGY_SCRIPT: path.join(__dirname, 'antigravityChatFixture.js'),
  EZSHELL_TEST_AGY_PROFILE: profile
})

// The fixture draws real ConPTY output. Capture input at node-pty so the tests can assert exactly
// which bytes reached the console, independent of cooked console input in Electron's Node mode.
let count = 0
const spawn = pty.spawn
pty.spawn = (file, args, options) => {
  const pane = String(++count)
  options.env.EZSHELL_TEST_AGY_PANE = pane
  const child = spawn(file, args, options)
  const write = child.write.bind(child)
  child.write = data => {
    const prefix = path.join(profile, `${pane}-agy-`)
    if (!fs.existsSync(prefix + 'ready') || fs.existsSync(prefix + 'ended')) return write(data)
    fs.appendFileSync(prefix + 'keys', JSON.stringify(data) + '\n')
  }
  return child
}

require('../../out/main/index.js')
