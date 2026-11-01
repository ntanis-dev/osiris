import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { osirisPaths } from "../src/paths.js";

// Test homes live in <repo>/.cache (gitignored), never in the real home.
export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CLI = join(REPO, "src", "cli.js");

export function tempHome(t) {
  const root = join(REPO, ".cache", `test-${randomBytes(5).toString("hex")}`);
  const home = join(root, "home");
  if (!home.startsWith(join(REPO, ".cache") + sep))
    throw new Error("test home outside .cache");
  mkdirSync(join(home, ".claude"), { recursive: true });
  t?.after?.(() => rmSync(root, { recursive: true, force: true }));
  return { root, home, paths: osirisPaths(home) };
}

export function write(file, content, mtime = null) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    typeof content === "string" ? content : JSON.stringify(content, null, 2),
  );
  if (mtime !== null) utimesSync(file, mtime / 1000, mtime / 1000);
}

export const jsonl = (entries) =>
  entries.map((e) => JSON.stringify(e)).join("\n") + "\n";

// The environment of a process outside any Claude Code session, terminal
// multiplexer or Baton wrapper, whatever runs the tests, with the classic
// console's glyphs and no forced colour, so output is the same everywhere.
export function testEnv(home, extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (
      /^(CLAUDE|BATON_|WT_|TMUX|TERM_PROGRAM|OSIRIS_)/i.test(key) ||
      key === "NO_COLOR" ||
      key === "FORCE_COLOR"
    )
      delete env[key];
  return { ...env, OSIRIS_HOME: home, OSIRIS_GLYPHS: "plain", ...extra };
}

// The environment Claude Code gives a hook in an interactive session.
export const hookEnv = (pid, extra = {}) => ({
  CLAUDE_CODE_ENTRYPOINT: "cli",
  CLAUDE_PID: String(pid),
  ...extra,
});

// Stand-ins for baton and claude, first on PATH (a restore looks them up).
export function withPrograms(env, root, names = ["baton", "claude"]) {
  const bin = join(root, "bin");
  for (const name of names) {
    write(join(bin, name), "#!/bin/sh\n");
    write(join(bin, `${name}.cmd`), "@echo off\r\n");
  }
  const key =
    Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  return { ...env, [key]: `${bin}${delimiter}${env[key] ?? ""}` };
}

export function runCli(args, { env, input } = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    env,
    input,
    encoding: "utf8",
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

export const SESSION = "0b6f4b1e-1c1d-4e5f-8a9b-0c1d2e3f4a5b";
export const OTHER = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
export const H = 3600e3;
export const M = 60e3;
