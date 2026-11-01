import { spawnSync } from "node:child_process";

// After a restore that opened every window, the terminal Osiris ran in has
// done its job, so Osiris closes it, as if its shell had exited (with code 0,
// so Windows Terminal closes the tab). Only a shell in a window of its own is
// closed: a console window or a Windows Terminal tab. A shell inside another
// program (an editor's terminal, Claude Code, another shell) stays. Windows
// only.

const SHELLS = /^(cmd|powershell|pwsh|bash|sh|zsh|fish|nu)\.exe$/i;
// What starts a shell in a window of its own: Explorer (a console window,
// from the Start menu or Run), Windows Terminal, the console host, mintty.
const HOSTS = /^(explorer|windowsterminal|openconsole|conhost|mintty)\.exe$/i;

// A shell that only runs a command (cmd /c, powershell -Command, bash -c): a
// step on the way from the shell you typed into, as npm's shims take it.
function runsCommand({ name, command }) {
  const args = ` ${command ?? ""} `;
  if (/^cmd\.exe$/i.test(name)) return /\s\/c[\s"]/i.test(args);
  if (/^(powershell|pwsh)\.exe$/i.test(name))
    return (
      /\s-(c|command|f|file|e|ec|encodedcommand)\s/i.test(args) &&
      !/\s-noexit\s/i.test(args)
    );
  return /\s-c\s/.test(args);
}

// The shell to close, from the chain of processes [osiris, its parent, ...]
// ({ pid, name, command }; the chain ends where a parent is gone): the first
// shell that is not only running a command, when a terminal started it (or
// its parent is gone); otherwise none.
export function shellToClose(chain) {
  for (let i = 1; i < chain.length; i++) {
    const process = chain[i];
    if (!SHELLS.test(process.name ?? "")) return null;
    if (runsCommand(process)) continue;
    const parent = chain[i + 1];
    return !parent || HOSTS.test(parent.name ?? "") ? process.pid : null;
  }
  return null;
}

// Lines of "<pid>|<parent>|<name>|<command line>".
export function parseChain(stdout) {
  const chain = [];
  for (const line of String(stdout).split(/\r?\n/)) {
    const m = /^(\d+)\|(\d+)\|([^|]*)\|(.*)$/.exec(line);
    if (m)
      chain.push({
        pid: Number(m[1]),
        ppid: Number(m[2]),
        name: m[3],
        command: m[4],
      });
  }
  return chain;
}

const powershell = (run, script) =>
  run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30e3,
  });

// A process and its parents, up to ten, or null when they cannot be read. A
// parent that started after its child is another process that took the id:
// the chain ends there.
export function processChain({ pid = process.pid, run = spawnSync } = {}) {
  const walk = powershell(
    run,
    `$id = ${Number(pid)}; $after = $null; for ($i = 0; $i -lt 10 -and $id -gt 0; $i++) { ` +
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId=$id"; if (-not $p) { break }; ` +
      `if ($after -and $p.CreationDate -gt $after) { break }; ` +
      `'{0}|{1}|{2}|{3}' -f $p.ProcessId, $p.ParentProcessId, $p.Name, $p.CommandLine; ` +
      `$after = $p.CreationDate; $id = $p.ParentProcessId }`,
  );
  return walk.error || walk.status !== 0 ? null : parseChain(walk.stdout);
}

// Closes the terminal; the shell's process id, or null when there is none to
// close (or it could not be).
export function closeTerminal({
  pid = process.pid,
  platform = process.platform,
  run = spawnSync,
} = {}) {
  if (platform !== "win32") return null;
  try {
    const chain = processChain({ pid, run });
    const shell = chain && shellToClose(chain);
    if (!shell) return null;
    const ended = powershell(
      run,
      `$r = Invoke-CimMethod -Query 'SELECT * FROM Win32_Process WHERE ProcessId=${shell}' ` +
        `-MethodName Terminate -Arguments @{ Reason = [uint32]0 }; exit $r.ReturnValue`,
    );
    return ended.error ? null : shell;
  } catch {
    return null;
  }
}
