import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Where everything lives. "home" is the user's home directory (OSIRIS_HOME
// overrides it, which the tests use). Osiris's own state is in ~/.osiris.
// ~/.claude is only read, except for the hooks `osiris install` adds to its
// settings.json; Baton's profiles are only looked at by `osiris doctor` and
// `osiris scan`.
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function resolveHome(env = process.env) {
  return resolve(env.OSIRIS_HOME || homedir());
}

export function osirisPaths(home) {
  const root = join(home, ".osiris");
  return {
    home,
    root,
    // One file per Claude Code process seen by the hooks.
    windows: join(root, "windows"),
    // The small scripts a restore opens each window with.
    launch: join(root, "launch"),
    install: join(root, "install.json"),
    backups: join(root, "backups"),
    claudeDir: join(home, ".claude"),
    // Baton's account profiles: each one a CLAUDE_CONFIG_DIR with its own
    // copy of (or link to) ~/.claude/settings.json.
    batonAccounts: join(home, ".baton", "accounts"),
  };
}

export const pathsFor = (env = process.env) => osirisPaths(resolveHome(env));

export const forward = (path) => String(path).replace(/\\/g, "/");
