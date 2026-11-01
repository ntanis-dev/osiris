import { readdirSync, realpathSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { iso } from "./fsutil.js";
import { ID_RE } from "./paths.js";
import { transcriptInfo } from "./transcript.js";

// `osiris scan`: the fallback for conversations the hooks never saw (before
// `osiris install`, or a profile without the hooks). It lists the
// transcripts written to in a span of time (by default the three hours
// before the computer started) and turns each into a window to restore. It
// is a guess: a transcript does not say whether its window was still open.

// Where transcripts live: ~/.claude/projects, the projects folder of every
// profile a window was recorded under, and Baton's profiles. Most profiles
// link to ~/.claude/projects; each real folder is read once, under the
// first profile that names it (null: the default one).
export function projectRoots(paths, windows = []) {
  const candidates = [
    { dir: join(paths.claudeDir, "projects"), configDir: null },
  ];
  for (const window of windows)
    if (window.configDir)
      candidates.push({
        dir: join(window.configDir, "projects"),
        configDir: window.configDir,
      });
  try {
    for (const id of readdirSync(paths.batonAccounts))
      candidates.push({
        dir: join(paths.batonAccounts, id, "projects"),
        configDir: join(paths.batonAccounts, id),
      });
  } catch {
    // no Baton
  }
  const seen = new Set();
  const out = [];
  for (const candidate of candidates) {
    let real;
    try {
      real = realpathSync(candidate.dir);
    } catch {
      continue;
    }
    const key = process.platform === "win32" ? real.toLowerCase() : real;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...candidate, real });
  }
  return out;
}

// Claude Code names a project's folder after the folder it ran in, every
// character other than a letter or a digit made "-".
export const projectKey = (cwd) => String(cwd).replace(/[^A-Za-z0-9]/g, "-");

// scanTranscripts(roots, { from, to, skip }) -> windows, newest first, each
// { session, cwd, configDir, transcript, lastSeen, info, scanned: true }.
// `skip` holds sessions to leave out (open in a live window).
export function scanTranscripts(roots, { from, to, skip = new Set() }) {
  const found = [];
  for (const root of roots) {
    let projects = [];
    try {
      projects = readdirSync(root.real);
    } catch {
      continue;
    }
    for (const project of projects) {
      const dir = join(root.real, project);
      let names = [];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith(".jsonl")) continue;
        const session = basename(name, ".jsonl");
        if (!ID_RE.test(session) || skip.has(session)) continue;
        const file = join(dir, name);
        let mtime;
        try {
          mtime = statSync(file).mtimeMs;
        } catch {
          continue;
        }
        if (mtime < from || mtime > to) continue;
        found.push({
          session,
          project,
          file,
          mtime,
          configDir: root.configDir,
        });
      }
    }
  }
  const out = [];
  for (const item of found) {
    const info = transcriptInfo(item.file, { bytes: 1 << 20 });
    if (!info) continue;
    // Only terminal sessions (not claude -p, the SDK, an IDE or the desktop
    // app), and not one that went on in another session.
    if (info.entrypoint && info.entrypoint !== "cli") continue;
    if (info.continuedIn) continue;
    const cwd =
      info.cwds.find((c) => projectKey(c) === item.project) ?? info.cwd;
    out.push({
      session: item.session,
      cwd,
      configDir: item.configDir,
      transcript: item.file,
      lastSeen: iso(item.mtime),
      wrapper: null,
      terminal: { kind: "console", profile: null },
      state: null,
      permissionMode: null,
      effort: null,
      info,
      scanned: true,
    });
  }
  return out.sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen));
}
