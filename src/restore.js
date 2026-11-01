import { existsSync } from "node:fs";
import { uptime } from "node:os";
import { ms } from "./fsutil.js";
import { runningProcesses } from "./processes.js";
import { resumeCommand, scriptSafe } from "./launch.js";
import { transcriptInfo } from "./transcript.js";
import {
  aliveCheck,
  classify,
  isEnded,
  listWindows,
  pruneWindows,
} from "./windows.js";

// What a restore works from: every record sorted (windows.js classify), the
// lost ones with what their transcripts say, and which of them to tick by
// default.

// When the computer started. OSIRIS_BOOT (a time) stands in for it, for the
// tests and for a restart Osiris cannot see (a sleep, Fast Startup).
export function bootTime(env = process.env, now = Date.now()) {
  const given = ms(env.OSIRIS_BOOT);
  return given ?? now - uptime() * 1000;
}

// Claude Code writes a conversation's transcript at its first prompt, so a
// window that never got one has none: it comes back as a new conversation in
// its folder, since there is nothing to resume.
const hasConversation = (window) =>
  !window.transcript || existsSync(window.transcript);

// A window with what its transcript says: { window, info, fresh }.
export function entryOf(window, { bytes }) {
  return {
    window,
    info: window.transcript
      ? transcriptInfo(window.transcript, { bytes })
      : null,
    fresh: !hasConversation(window),
  };
}

// state({ paths, env, now, all, processes }) -> { groups, bootAt, lost }
// lost: [{ window, info, fresh }] newest first.
export function state({
  paths,
  env = process.env,
  now = Date.now(),
  all = false,
  processes = runningProcesses,
}) {
  const bootAt = bootTime(env, now);
  const windows = listWindows(paths);
  const running = processes(
    windows.filter((w) => !isEnded(w)).map((w) => w.pid),
  );
  const groups = classify(windows, {
    alive: aliveCheck(running, { bootAt }),
    bootAt,
    all,
    conversation: hasConversation,
  });
  pruneWindows(groups, now);
  const lost = groups.lost.map((window) => entryOf(window, { bytes: 1 << 20 }));
  return { groups, bootAt, lost };
}

// The windows to tick: the ones lost in the restart when there are any
// (the others were closed since, without exiting), otherwise all.
export function defaultTicks(entries) {
  const before = entries.map((e) => Boolean(e.window.beforeBoot));
  return before.some(Boolean) ? before : entries.map(() => true);
}

// Each entry gets its command, and `problem` when it cannot be restored.
export function withCommands(
  entries,
  { baton = true, platform = process.platform } = {},
) {
  for (const entry of entries) {
    entry.command = resumeCommand(entry.window, entry.info, {
      baton,
      fresh: entry.fresh,
    });
    const { cwd, configDir } = entry.command;
    if (!cwd) entry.problem = "its folder is unknown";
    else if (!existsSync(cwd)) entry.problem = `its folder is gone (${cwd})`;
    else if (!scriptSafe(cwd, platform) || !scriptSafe(configDir, platform))
      entry.problem = "its folder name cannot be put in a script safely";
  }
  return entries;
}
