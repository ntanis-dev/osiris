import { spawn } from "node:child_process";
import { existsSync, lstatSync, readdirSync, rmSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { writeFileAtomic } from "./fsutil.js";

// Bringing windows back. Each lost window becomes a command (resumeCommand:
// the program, its arguments, the folder and the profile), written to a small
// script in ~/.osiris/launch (so no value is ever quoted through two shells),
// and that script is opened in a terminal like the one the window ran in:
//  - Windows: inside Windows Terminal, a tab of the window Osiris runs in;
//    elsewhere a console window of its own (start ... cmd /k script), or a
//    tab of one new Windows Terminal window for windows that ran there;
//  - elsewhere: a tmux window when Osiris runs inside tmux;
//  - or only printed (--print), to run by hand.
// The shell stays open after Claude Code exits, as it was before.

// A value passed on to claude: model ids ("claude-opus-5-5[1m]"), effort
// levels and permission modes. Anything else is left out.
const TOKEN_RE = /^[A-Za-z0-9._:@[\]-]{1,100}$/;
const token = (value) =>
  typeof value === "string" && TOKEN_RE.test(value) ? value : null;

// The environment a Claude Code process gives its children (Osiris may run
// inside a session): a restored window must not inherit it.
const INJECTED =
  /^(CLAUDECODE|CLAUDE_PID|CLAUDE_ENV_FILE|CLAUDE_PROJECT_DIR|CLAUDE_EFFORT|CLAUDE_CONFIG_DIR|BATON_WRAPPER|CLAUDE_CODE_(ENTRYPOINT|SESSION_ID|CHILD_SESSION|SESSION_ATTENDED|MESSAGING_\w+|EXECPATH|SSE_PORT))$/i;

export const cleanEnv = (env) =>
  Object.fromEntries(
    Object.entries(env).filter(([key]) => !INJECTED.test(key)),
  );

// A program file. Windows' app execution aliases (WindowsApps\wt.exe) are
// links that cannot be followed with stat (EACCES), yet start fine: the link
// itself counts.
function isProgram(file) {
  try {
    return statSync(file).isFile();
  } catch {
    try {
      return lstatSync(file).isSymbolicLink();
    } catch {
      return false;
    }
  }
}

// A program on PATH (with PATHEXT on Windows), or null.
export function which(
  name,
  { env = process.env, platform = process.platform } = {},
) {
  const pathKey =
    Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  const dirs = String(env[pathKey] ?? "").split(
    platform === "win32" ? ";" : delimiter,
  );
  const exts =
    platform === "win32"
      ? String(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .filter(Boolean)
      : [""];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of exts) {
      const file = join(dir.replace(/^"|"$/g, ""), name + ext);
      if (isProgram(file)) return file;
    }
  }
  return null;
}

// A title any shell and terminal take as it is.
export function safeTitle(title) {
  const clean = String(title ?? "")
    .replace(/[\u0000-\u001f\u007f&|<>^"%!;`$\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean.slice(0, 80) || "Claude Code";
}

// The command that brings a window back: { program, args, configDir, cwd,
// title, via }. A window Baton started goes back through Baton (which picks
// the account again); without Baton on PATH it resumes in plain
// claude under the profile it was last on. A scanned one goes through Baton
// when asked (viaBaton). A `fresh` one (no conversation yet) starts a new
// conversation in its folder.
export const FRESH_TITLE = "New conversation";

export function resumeCommand(
  window,
  info = null,
  { baton = true, fresh = false } = {},
) {
  const via = (window.wrapper || window.viaBaton) && baton ? "baton" : "claude";
  const options = [];
  const model = token(info?.model);
  const effort = token(window.effort ?? info?.effort);
  const mode = token(window.permissionMode ?? info?.permissionMode);
  if (model) options.push("--model", model);
  if (effort) options.push("--effort", effort);
  if (mode && mode !== "default") options.push("--permission-mode", mode);
  return {
    via,
    program: via,
    args: [...(fresh ? [] : ["--resume", window.session]), ...options],
    configDir: via === "claude" ? (window.configDir ?? null) : null,
    cwd: window.cwd ?? info?.cwd ?? null,
    title: safeTitle(info?.title ?? (fresh ? FRESH_TITLE : window.session)),
  };
}

// Whether a folder name can sit between the double quotes of a script line:
// a Windows batch file ends the quotes at a quote mark and starts a new
// command at a line break (a folder cannot be named so there, but the
// profile folder comes from an environment variable and is not looked up).
// The POSIX script quotes everything with single quotes, which hold both.
export const scriptSafe = (value, platform = process.platform) =>
  !value || platform !== "win32" || !/["\u0000-\u001f\u007f]/.test(value);

// cmd.exe reads a batch file in the console's code page until told
// otherwise, and expands %...% everywhere.
const batch = (value) => String(value).replace(/%/g, "%%");

export function windowsScript(command) {
  const lines = [];
  const text = [command.title, command.cwd, command.configDir].join("");
  if (/[^\x00-\x7f]/.test(text)) lines.push("@chcp 65001 >nul");
  lines.push(`@title ${batch(command.title)}`);
  if (command.cwd) lines.push(`@cd /d "${batch(command.cwd)}"`);
  if (command.configDir)
    lines.push(`@set "CLAUDE_CONFIG_DIR=${batch(command.configDir)}"`);
  lines.push(`@call ${[command.program, ...command.args].join(" ")}`);
  return lines.join("\r\n") + "\r\n";
}

const sh = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

export function posixScript(command) {
  const lines = ["#!/bin/sh"];
  if (command.cwd) lines.push(`cd ${sh(command.cwd)} || exit 1`);
  if (command.configDir)
    lines.push(`export CLAUDE_CONFIG_DIR=${sh(command.configDir)}`);
  else lines.push("unset CLAUDE_CONFIG_DIR");
  lines.push(`printf '\\033]0;%s\\007' ${sh(command.title)}`);
  lines.push([command.program, ...command.args].join(" "));
  lines.push('exec "${SHELL:-/bin/sh}"');
  return lines.join("\n") + "\n";
}

// The command as a person would type it, for --print.
export function commandLines(command, platform = process.platform) {
  const run = [command.program, ...command.args].join(" ");
  if (platform === "win32")
    return [
      ...(command.cwd ? [`cd /d "${command.cwd}"`] : []),
      ...(command.configDir
        ? [`set "CLAUDE_CONFIG_DIR=${command.configDir}"`]
        : []),
      run,
    ];
  return [
    ...(command.cwd ? [`cd ${sh(command.cwd)}`] : []),
    command.configDir
      ? `CLAUDE_CONFIG_DIR=${sh(command.configDir)} ${run}`
      : run,
  ];
}

// Where a window goes back to: "wt", "console", "tmux" or "print". `mode`
// is the operator's choice (auto, wt, console, tmux, print). Run inside
// Windows Terminal, every window comes back as a tab there; run anywhere else,
// the windows that ran in Windows Terminal get tabs of a new window of it.
export function terminalFor(window, { mode = "auto", platform, env, wt }) {
  if (mode !== "auto") return mode;
  if (platform === "win32")
    return wt && (env.WT_SESSION || window.terminal?.kind === "wt")
      ? "wt"
      : "console";
  return env.TMUX ? "tmux" : "print";
}

// wt reads ";" as the start of its next command.
const wtArg = (value) => String(value).replace(/;/g, "\\;");

// planLaunch(entries, { paths, platform, env, mode, wt, now }) ->
//   { spawns: [{ file, args, options, entries }], printed: [entry] }
// entries: [{ window, command }]; each gets its terminal and script.
export function planLaunch(
  entries,
  {
    paths,
    platform = process.platform,
    env = process.env,
    mode = "auto",
    wt = null,
    now = Date.now(),
  },
) {
  const spawns = [];
  const printed = [];
  const tabs = [];
  const childEnv = cleanEnv(env);
  for (const entry of entries) {
    entry.terminal = terminalFor(entry.window, { mode, platform, env, wt });
    if (entry.terminal === "print") {
      printed.push(entry);
      continue;
    }
    const ext = platform === "win32" ? "cmd" : "sh";
    entry.script = join(paths.launch, `${entry.window.session}-${now}.${ext}`);
    writeFileAtomic(
      entry.script,
      platform === "win32"
        ? windowsScript(entry.command)
        : posixScript(entry.command),
    );
    if (entry.terminal === "wt") tabs.push(entry);
    else if (entry.terminal === "console")
      spawns.push({
        file: env.ComSpec || env.COMSPEC || "cmd.exe",
        args: [
          "/d",
          "/s",
          "/c",
          `"start "${entry.command.title}" cmd.exe /d /k "${entry.script}""`,
        ],
        options: {
          cwd: existsSync(entry.command.cwd ?? "")
            ? entry.command.cwd
            : undefined,
          env: childEnv,
          detached: true,
          stdio: "ignore",
          windowsVerbatimArguments: true,
        },
        entries: [entry],
      });
    else if (entry.terminal === "tmux")
      spawns.push({
        file: "tmux",
        args: [
          "new-window",
          "-d",
          "-n",
          entry.command.title,
          ...(entry.command.cwd ? ["-c", entry.command.cwd] : []),
          `sh ${sh(entry.script)}`,
        ],
        options: { env: childEnv, detached: true, stdio: "ignore" },
        entries: [entry],
      });
  }
  if (tabs.length)
    spawns.unshift({
      file: wt ?? "wt.exe",
      args: [
        // 0 is the current window: the one Osiris was run in, when there is one.
        "-w",
        env.WT_SESSION ? "0" : "new",
        ...tabs.flatMap((entry, i) => [
          ...(i ? [";"] : []),
          "new-tab",
          "--title",
          wtArg(entry.command.title),
          ...(entry.command.cwd ? ["-d", wtArg(entry.command.cwd)] : []),
          ...(entry.window.terminal?.profile
            ? ["-p", wtArg(entry.window.terminal.profile)]
            : []),
          "cmd.exe",
          "/d",
          "/k",
          wtArg(entry.script),
        ]),
      ],
      options: { env: childEnv, detached: true, stdio: "ignore" },
      entries: tabs,
    });
  return { spawns, printed };
}

const started = (child) =>
  new Promise((resolve) => {
    child.once("spawn", () => resolve(null));
    child.once("error", (error) => resolve(error));
  });

// Starts each planned process, one at a time with a short pause (ten Claude
// Code processes starting at once contend for the same files). Each entry
// gets `error` when its process could not start.
export async function runLaunch(plan, { run = spawn, pause = 700 } = {}) {
  for (let i = 0; i < plan.spawns.length; i++) {
    const item = plan.spawns[i];
    let error = null;
    try {
      const child = run(item.file, item.args, item.options);
      error = await started(child);
      child.unref?.();
    } catch (caught) {
      error = caught;
    }
    for (const entry of item.entries) entry.error = error?.message ?? null;
    if (i < plan.spawns.length - 1 && pause > 0)
      await new Promise((resolve) => setTimeout(resolve, pause));
  }
}

// Scripts from earlier restores (a day old: their windows opened long ago).
export function pruneScripts(paths, now = Date.now()) {
  let names = [];
  try {
    names = readdirSync(paths.launch);
  } catch {
    return;
  }
  for (const name of names) {
    const file = join(paths.launch, name);
    try {
      if (now - statSync(file).mtimeMs > 864e5) rmSync(file, { force: true });
    } catch {
      // gone
    }
  }
}
