import { readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { iso, isAlive, ms, readJson, writeJsonAtomic } from "./fsutil.js";

// The window records. Every interactive Claude Code process the hooks see is
// a window: windows/<pid>.json while it is the latest process with that id,
// renamed to windows/<pid>-<first seen>.json when another process takes the
// id over (Windows reuses process ids quickly).
//
// { version, pid, firstSeen, lastSeen, session, cwd, transcript, configDir,
//   wrapper, terminal: { kind, profile }, state: running|idle,
//   permissionMode, effort, end: null | { at, reason },
//   handled: null | { at, action: restored|dismissed } }

// SessionEnd reasons that only switch the process to another conversation
// (/resume, /clear): the window stays open on the next one.
export const SWITCH_REASONS = ["resume", "clear"];

// The reason a session ends with when its window is closed from outside: its
// X, End task, a closed Windows Terminal tab, or Windows closing every window
// for a restart or an update. Exiting at the prompt (/exit, Ctrl+C, Ctrl+D)
// ends it with prompt_input_exit instead.
export const CLOSED_REASON = "other";

const DAY = 864e5;
// Windows closed within five minutes of the last one were closed together:
// a restart closes them all in seconds, and so does ending a terminal.
const CLOSING = 5 * 60e3;
// A restart closes the windows within the hour before the computer starts
// again (an update can take a while).
const RESTART = 60 * 60e3;
// A window that never got a prompt and ended within three seconds of
// starting was never really open (a claude that failed to start, say).
const BRIEF = 3e3;

export const windowFile = (paths, pid) => join(paths.windows, `${pid}.json`);

export function archiveWindow(paths, record) {
  const from = windowFile(paths, record.pid);
  const to = join(
    paths.windows,
    `${record.pid}-${ms(record.firstSeen) ?? 0}.json`,
  );
  try {
    renameSync(from, to);
  } catch {
    writeJsonAtomic(to, record);
    rmSync(from, { force: true });
  }
}

// Every record, each with the file it came from.
export function listWindows(paths) {
  let names = [];
  try {
    names = readdirSync(paths.windows);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!/^\d+(-\d+)?\.json$/.test(name)) continue;
    const file = join(paths.windows, name);
    const record = readJson(file);
    if (!record || typeof record !== "object" || !record.session) continue;
    out.push({ ...record, file });
  }
  return out;
}

export function saveWindow(window) {
  const { file, beforeBoot, ...record } = window;
  writeJsonAtomic(file, record);
}

// Whether a window's process still runs. `running` maps a process id to its
// start time (processes.js); a process that started after the window was
// first seen is another one with the same id. Without it (the process list
// could not be read), a process seen only before the computer started
// cannot be running.
export function aliveCheck(running, { bootAt }) {
  return (window) => {
    if (running) {
      const process = running.get(window.pid);
      if (!process) return false;
      return (
        process.startedAt === null ||
        process.startedAt <= (ms(window.firstSeen) ?? 0) + 60e3
      );
    }
    return isAlive(window.pid) && (ms(window.lastSeen) ?? 0) >= bootAt;
  };
}

const lastSeen = (window) => ms(window.lastSeen) ?? 0;
const endedAt = (window) => ms(window.end?.at) ?? lastSeen(window);

// Whether the window's process is done: its session ended other than by
// switching to the next one.
export const isEnded = (window) =>
  Boolean(window.end && !SWITCH_REASONS.includes(window.end.reason));

const wasClosed = (window) =>
  isEnded(window) && window.end.reason === CLOSED_REASON;

// When the windows closed from outside that come back were closed: the last
// time since the computer started, and the time a restart closed them (the
// last closing in the hour before the start, with no window seen after it).
function closings(closed, windows, bootAt) {
  const latest = (list) =>
    list.reduce((t, w) => Math.max(t, endedAt(w)), -Infinity);
  const since = latest(closed.filter((w) => endedAt(w) >= bootAt));
  const before = latest(closed.filter((w) => endedAt(w) < bootAt));
  const quiet = !windows.some(
    (w) => !wasClosed(w) && lastSeen(w) > before + 60e3 && lastSeen(w) < bootAt,
  );
  return [since, bootAt - before <= RESTART && quiet ? before : null].filter(
    Number.isFinite,
  );
}

// Sorts the records into:
//  - live: the process still runs;
//  - closed: its session ended at the prompt (/exit, Ctrl+C, logout), or its
//    window was closed from outside before the last ones;
//  - lost: the process is gone without its session ending (a freeze, a hard
//    reset, a killed process), or its window was closed from outside with
//    the last ones closed together, or with the ones a restart closed;
//    newest first. `beforeBoot` marks the ones last seen before the computer
//    started.
// A lost window is left out (superseded) when its conversation went on
// elsewhere: open in a live window, in a later window, or in a later window
// of the same Baton wrapper (Baton moved it to another account). One already
// restored or dismissed is left out (handled) unless `all`. `conversation`
// says whether a window has a transcript yet.
export function classify(
  windows,
  { alive, bootAt, all = false, conversation = () => true },
) {
  const groups = {
    live: [],
    lost: [],
    closed: [],
    superseded: [],
    handled: [],
  };
  const gone = [];
  const closed = [];
  for (const window of windows) {
    if (!isEnded(window)) {
      if (alive(window)) groups.live.push(window);
      else gone.push(window);
    } else if (
      wasClosed(window) &&
      (conversation(window) ||
        endedAt(window) - (ms(window.firstSeen) ?? 0) >= BRIEF)
    )
      closed.push(window);
    else groups.closed.push(window);
  }
  const times = closings(closed, windows, bootAt);
  for (const window of closed) {
    const at = endedAt(window);
    if (times.some((t) => at <= t && at > t - CLOSING)) gone.push(window);
    else groups.closed.push(window);
  }
  for (const window of gone) {
    const elsewhere =
      groups.live.some((x) => x.session === window.session) ||
      windows.some(
        (x) =>
          x !== window &&
          lastSeen(x) > lastSeen(window) &&
          (x.session === window.session ||
            (window.wrapper && x.wrapper === window.wrapper)),
      );
    if (elsewhere) groups.superseded.push(window);
    else if (window.handled && !all) groups.handled.push(window);
    else groups.lost.push({ ...window, beforeBoot: lastSeen(window) < bootAt });
  }
  groups.lost.sort((a, b) => lastSeen(b) - lastSeen(a));
  groups.live.sort((a, b) => lastSeen(b) - lastSeen(a));
  return groups;
}

export function markHandled(windows, action, now = Date.now()) {
  for (const window of windows)
    saveWindow({ ...window, handled: { at: iso(now), action } });
}

// Forgets what no restore will offer again: closed, superseded and handled
// windows after two weeks, anything after two months.
export function pruneWindows(groups, now = Date.now()) {
  let removed = 0;
  const old = (window, days) => now - lastSeen(window) > days * DAY;
  for (const window of [
    ...groups.closed,
    ...groups.superseded,
    ...groups.handled,
    ...groups.lost,
  ]) {
    const done = !groups.lost.includes(window);
    if (old(window, 60) || (done && old(window, 14))) {
      rmSync(window.file, { force: true });
      removed++;
    }
  }
  return removed;
}
