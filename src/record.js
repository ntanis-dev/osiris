import { normalize } from "node:path";
import { ID_RE } from "./paths.js";
import { iso, ms, readJson, writeJsonAtomic } from "./fsutil.js";
import { SWITCH_REASONS, archiveWindow, windowFile } from "./windows.js";

// The hook handler. Claude Code runs `osiris record <event>` on every
// session event, so it is small, synchronous, writes one file atomically,
// prints nothing (a SessionStart or UserPromptSubmit hook's stdout would
// reach the model) and never throws: bad input is ignored.
//
// It keeps one record per Claude Code process (its CLAUDE_PID): the
// conversation it is on, its folder, its profile (CLAUDE_CONFIG_DIR), the
// Baton wrapper that started it (BATON_WRAPPER, when Baton did) and
// the terminal it runs in. Only interactive sessions count:
// CLAUDE_CODE_ENTRYPOINT is "cli" there, and something else under
// `claude -p`, the Agent SDK, the IDE extensions and the desktop app.

export const EVENTS = {
  "session-start": "SessionStart",
  prompt: "UserPromptSubmit",
  stop: "Stop",
  "stop-failure": "StopFailure",
  "session-end": "SessionEnd",
};

const text = (value, n = 4096) =>
  typeof value === "string" && value && value.length <= n ? value : null;

const folder = (value) => (text(value) ? normalize(value) : null);

// The terminal a window runs in: Windows Terminal (WT_SESSION, with the
// profile it was opened with), tmux, another terminal that says its name, or
// a plain console window.
export function terminalOf(env) {
  if (env.WT_SESSION)
    return { kind: "wt", profile: text(env.WT_PROFILE_ID, 200) };
  if (env.TMUX) return { kind: "tmux", profile: null };
  if (env.TERM_PROGRAM)
    return { kind: env.TERM_PROGRAM.toLowerCase().slice(0, 40), profile: null };
  return { kind: "console", profile: null };
}

// Whether a SessionStart continues the process on record rather than begin
// a new one that reuses its id. A fresh start never continues; /resume and
// /clear end the old session (reason resume or clear) moments before they
// start the next one in the same process; a compaction keeps its session.
function continues(record, input, now) {
  if (input.source === "startup") return false;
  if (input.source === "compact") return true;
  if (record.session === input.session_id && !record.end) return true;
  return Boolean(
    record.end &&
    SWITCH_REASONS.includes(record.end.reason) &&
    now - (ms(record.end.at) ?? 0) < 10 * 60e3,
  );
}

// handleRecord(event, input, { env, paths, now }) -> the record written, or null
export function handleRecord(
  event,
  input,
  { env = process.env, paths, now = Date.now() },
) {
  if (!input || typeof input !== "object" || !(event in EVENTS)) return null;
  if (env.CLAUDE_CODE_ENTRYPOINT !== "cli") return null;
  const pid = Number(env.CLAUDE_PID);
  const session = input.session_id;
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (typeof session !== "string" || !ID_RE.test(session)) return null;

  const file = windowFile(paths, pid);
  let record = readJson(file);
  if (!record || record.pid !== pid) record = null;
  if (event === "session-start" && record && !continues(record, input, now)) {
    archiveWindow(paths, record);
    record = null;
  }
  // The end of a session the process already left: nothing to change.
  if (event === "session-end" && record && record.session !== session)
    return record;

  const at = iso(now);
  const moved = record && record.session !== session;
  const next = {
    version: 1,
    pid,
    firstSeen: record?.firstSeen ?? at,
    lastSeen: at,
    session,
    // The folder the process started in (its project): the one to resume
    // in, even when the session's working folder moved since.
    cwd:
      folder(env.CLAUDE_PROJECT_DIR) ??
      folder(input.cwd) ??
      record?.cwd ??
      null,
    transcript: text(input.transcript_path) ?? record?.transcript ?? null,
    configDir: text(env.CLAUDE_CONFIG_DIR),
    wrapper: ID_RE.test(env.BATON_WRAPPER ?? "") ? env.BATON_WRAPPER : null,
    terminal: terminalOf(env),
    state: moved ? "idle" : (record?.state ?? "idle"),
    permissionMode:
      text(input.permission_mode, 40) ?? record?.permissionMode ?? null,
    effort: text(input.effort?.level, 40) ?? record?.effort ?? null,
    end: moved ? null : (record?.end ?? null),
    handled: moved ? null : (record?.handled ?? null),
  };
  if (event === "session-start") {
    next.state = "idle";
    next.end = null;
    next.handled = null;
  } else if (event === "prompt") {
    next.state = "running";
    next.end = null;
  } else if (event === "stop" || event === "stop-failure") {
    next.state = "idle";
  } else if (event === "session-end") {
    next.state = "idle";
    next.end = { at, reason: text(input.reason, 80) ?? "other" };
  }
  writeJsonAtomic(file, next);
  return next;
}
