import { spawnSync } from "node:child_process";

// Which of some processes still run, and since when: a Map of process id to
// { startedAt } (milliseconds, or null when unknown), or null when the
// process list cannot be read. One query for all of them, at restore time
// only (the hooks never ask): Win32_Process on Windows, ps elsewhere.

// ps's elapsed time, [[dd-]hh:]mm:ss, in seconds.
export function parseElapsed(text) {
  const m = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(String(text).trim());
  if (!m) return null;
  const [, d = 0, h = 0, min, s] = m;
  return ((Number(d) * 24 + Number(h)) * 60 + Number(min)) * 60 + Number(s);
}

export function parsePs(stdout, now) {
  const out = new Map();
  for (const line of String(stdout).split("\n")) {
    const m = /^\s*(\d+)\s+(\S+)/.exec(line);
    if (!m) continue;
    const seconds = parseElapsed(m[2]);
    out.set(Number(m[1]), {
      startedAt: seconds === null ? null : now - seconds * 1000,
    });
  }
  return out;
}

// Lines of "<pid> <creation time, ISO 8601>" from PowerShell.
export function parseWin32(stdout) {
  const out = new Map();
  for (const line of String(stdout).split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\S+)\s*$/.exec(line);
    if (!m) continue;
    const t = Date.parse(m[2]);
    out.set(Number(m[1]), { startedAt: Number.isFinite(t) ? t : null });
  }
  return out;
}

export function runningProcesses(
  pids,
  { platform = process.platform, run = spawnSync, now = Date.now() } = {},
) {
  const wanted = [...new Set(pids)].filter(
    (pid) => Number.isSafeInteger(pid) && pid > 0,
  );
  if (!wanted.length) return new Map();
  try {
    if (platform === "win32") {
      const filter = wanted.map((pid) => `ProcessId=${pid}`).join(" OR ");
      const script =
        `Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object ` +
        `{ '{0} {1}' -f $_.ProcessId, $_.CreationDate.ToUniversalTime().ToString('o') }`;
      const result = run(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { encoding: "utf8", windowsHide: true, timeout: 30e3 },
      );
      if (result.error || result.status !== 0) return null;
      return parseWin32(result.stdout);
    }
    const result = run("ps", ["-o", "pid=,etime=", "-p", wanted.join(",")], {
      encoding: "utf8",
      timeout: 30e3,
    });
    // ps exits with 1 when some of the processes are gone, and still lists
    // the others.
    if (result.error || (result.status !== 0 && result.status !== 1))
      return null;
    return parsePs(result.stdout, now);
  } catch {
    return null;
  }
}
