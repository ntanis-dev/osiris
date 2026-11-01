import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { diffLines } from "./diff.js";
import {
  iso,
  readJson,
  readText,
  writeFileAtomic,
  writeJsonAtomic,
} from "./fsutil.js";
import { forward } from "./paths.js";
import { EVENTS } from "./record.js";

// `osiris install` / `osiris uninstall`: the only change Osiris makes outside
// ~/.osiris. It adds command hooks (exec form: node + Osiris's cli.js, no
// shell) for SessionStart, UserPromptSubmit, Stop, StopFailure and
// SessionEnd to ~/.claude/settings.json. Baton shares that file with every
// account profile (a link, or a copy it refreshes at each launch), so the
// same hooks see plain claude and Baton's sessions. The change is planned
// first (the plan is what --dry-run shows), the previous file is backed up
// under ~/.osiris/backups/<time>/, the write is atomic, and running it again
// changes nothing. Uninstall removes exactly Osiris's entries.

const EVENT_NAMES = Object.values(EVENTS);

export const settingsPath = (paths) => join(paths.claudeDir, "settings.json");

export function isOsirisHandler(handler) {
  return (
    handler?.type === "command" &&
    Array.isArray(handler.args) &&
    handler.args.length >= 3 &&
    handler.args[1] === "record" &&
    /[\\/]src[\\/]cli\.js$/i.test(String(handler.args[0])) &&
    handler.args[2] in EVENTS
  );
}

export function hookHandler(nodePath, cliPath, event) {
  return {
    type: "command",
    command: forward(nodePath),
    args: [forward(cliPath), "record", event],
    timeout: 10,
  };
}

function jsonFormat(text) {
  if (!text) return { indent: 2, eol: "\n", trailing: true };
  const m = /\n([ \t]+)"/.exec(text);
  return {
    indent: m ? m[1] : 2,
    eol: text.includes("\r\n") ? "\r\n" : "\n",
    trailing: /\r?\n$/.test(text),
  };
}

const render = (value, format) => {
  const text = JSON.stringify(value, null, format.indent).replace(
    /\n/g,
    format.eol,
  );
  return format.trailing ? text + format.eol : text;
};

export class InstallError extends Error {}

export function readSettings(file) {
  const text = readText(file);
  if (text === null || !text.trim()) return { text, value: {} };
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("not an object");
    return { text, value };
  } catch (error) {
    throw new InstallError(
      `${file} is not valid JSON (${error.message}); fix it first.`,
    );
  }
}

const clone = (v) => JSON.parse(JSON.stringify(v));

function withoutOsirisHooks(hooks) {
  const out = {};
  for (const [event, groups] of Object.entries(hooks ?? {})) {
    if (!Array.isArray(groups)) {
      out[event] = groups;
      continue;
    }
    const kept = [];
    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks)) {
        kept.push(group);
        continue;
      }
      const handlers = group.hooks.filter((h) => !isOsirisHandler(h));
      if (handlers.length === group.hooks.length) kept.push(group);
      else if (handlers.length) kept.push({ ...group, hooks: handlers });
    }
    if (kept.length) out[event] = kept;
  }
  return out;
}

const handlersIn = (hooks, event) =>
  (Array.isArray(hooks?.[event]) ? hooks[event] : [])
    .flatMap((g) => (Array.isArray(g?.hooks) ? g.hooks : []))
    .filter(isOsirisHandler);

export const hasOsirisHooks = (hooks) =>
  Object.keys(hooks ?? {}).some((event) => handlersIn(hooks, event).length);

function sameOsirisHooks(hooks, desired) {
  for (const [event, handler] of Object.entries(desired)) {
    const found = handlersIn(hooks, event);
    if (
      found.length !== 1 ||
      JSON.stringify(found[0]) !== JSON.stringify(handler)
    )
      return false;
  }
  return !Object.keys(hooks ?? {}).some(
    (event) => !(event in desired) && handlersIn(hooks, event).length,
  );
}

// planInstall -> { files: [{ path, before, after, diff }], action, record }
// (action: add, update or same).
export function planInstall({ paths, nodePath = process.execPath, cliPath }) {
  const file = settingsPath(paths);
  const { text, value } = readSettings(file);
  const settings = clone(value);
  const desired = {};
  for (const [name, event] of Object.entries(EVENTS))
    desired[event] = hookHandler(nodePath, cliPath, name);
  let action = "same";
  if (!sameOsirisHooks(settings.hooks, desired)) {
    action = hasOsirisHooks(settings.hooks) ? "update" : "add";
    const hooks = withoutOsirisHooks(settings.hooks);
    for (const [event, handler] of Object.entries(desired))
      hooks[event] = [...(hooks[event] ?? []), { hooks: [handler] }];
    settings.hooks = hooks;
  }
  const after = render(settings, jsonFormat(text));
  return {
    action,
    files:
      after === text
        ? []
        : [{ path: file, before: text, after, diff: diffLines(text, after) }],
    record: {
      version: 1,
      cli: forward(cliPath),
      node: forward(nodePath),
      settingsPath: file,
      hooks: EVENT_NAMES,
    },
  };
}

export function planUninstall({ paths }) {
  const file = settingsPath(paths);
  const { text, value } = readSettings(file);
  const settings = clone(value);
  const had = hasOsirisHooks(settings.hooks);
  if (settings.hooks) {
    const hooks = withoutOsirisHooks(settings.hooks);
    if (Object.keys(hooks).length) settings.hooks = hooks;
    else delete settings.hooks;
  }
  const after =
    text === null && !Object.keys(settings).length
      ? null
      : render(settings, jsonFormat(text));
  return {
    action: had ? "remove" : "absent",
    files:
      after === text || (text === null && after === null)
        ? []
        : [{ path: file, before: text, after, diff: diffLines(text, after) }],
    record: null,
  };
}

const recordKey = (r) =>
  r ? JSON.stringify({ ...r, installedAt: null, backup: null }) : null;

export function planIsNoop(plan, paths) {
  const existing = readJson(paths.install);
  return (
    !plan.files.length &&
    (plan.record ? recordKey(existing) === recordKey(plan.record) : !existing)
  );
}

// Writes a plan: the backup first, then the file atomically (through a
// symbolic link to its target), then the record. Returns the backup folder.
export function applyPlan(plan, { paths, now = Date.now() }) {
  if (planIsNoop(plan, paths)) return { changed: false, backup: null };
  let backup = null;
  for (const f of plan.files) {
    if (f.before === null) continue;
    backup = join(paths.backups, iso(now).replace(/[:.]/g, "-"));
    mkdirSync(backup, { recursive: true });
    writeFileAtomic(join(backup, "settings.json"), f.before);
  }
  for (const f of plan.files) {
    let target = f.path;
    try {
      if (lstatSync(target).isSymbolicLink()) target = realpathSync(target);
    } catch {
      // a new file
    }
    if (f.after === null) rmSync(target, { force: true });
    else writeFileAtomic(target, f.after);
  }
  if (plan.record)
    writeJsonAtomic(paths.install, {
      ...plan.record,
      installedAt: iso(now),
      backup: backup ?? readJson(paths.install)?.backup ?? null,
    });
  else rmSync(paths.install, { force: true });
  return { changed: true, backup };
}

// Which of Osiris's hooks a settings.json has: { ok, events: { [event]:
// { installed, cliExists, nodeExists } } } (for doctor).
export function hookState(file) {
  let settings;
  try {
    settings = readSettings(file).value;
  } catch {
    return { ok: false, error: "not valid JSON" };
  }
  const events = {};
  for (const event of EVENT_NAMES) {
    const handler = handlersIn(settings.hooks, event)[0];
    events[event] = handler
      ? {
          installed: true,
          cliExists: existsSync(handler.args[0]),
          nodeExists: existsSync(handler.command),
        }
      : { installed: false };
  }
  return { ok: true, events };
}
