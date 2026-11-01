import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readJson } from "../src/fsutil.js";
import {
  OTHER,
  SESSION,
  jsonl,
  runCli,
  tempHome,
  testEnv,
  withPrograms,
  write,
} from "./helpers.js";

// A home with one window lost in a crash: recorded through the hooks, as
// Claude Code would run them, by a process that is gone.
function crashedHome(t) {
  const { home, paths } = tempHome(t);
  const app = join(home, "work", "app");
  mkdirSync(app, { recursive: true });
  const transcript = join(paths.claudeDir, "projects", "p", `${SESSION}.jsonl`);
  write(
    transcript,
    jsonl([
      { type: "custom-title", customTitle: "Payments refactor" },
      { type: "assistant", requestedModel: "claude-opus-5-5", effort: "high" },
    ]),
  );
  const hook = (event, input) =>
    runCli(["record", event], {
      env: testEnv(home, {
        CLAUDE_CODE_ENTRYPOINT: "cli",
        // A process id no running process has.
        CLAUDE_PID: "4000000",
        CLAUDE_PROJECT_DIR: app,
      }),
      input: JSON.stringify({
        session_id: SESSION,
        transcript_path: transcript,
        ...input,
      }),
    });
  assert.equal(hook("session-start", { source: "startup" }).code, 0);
  assert.equal(hook("prompt", { permission_mode: "plan" }).stdout, "");
  // The computer restarts after the window was last seen.
  const env = testEnv(home, {
    OSIRIS_BOOT: new Date(Date.now() + 60e3).toISOString(),
  });
  return { home, paths, app, env };
}

test("the hooks record a window that a restore then offers", (t) => {
  const { paths, app, env } = crashedHome(t);
  assert.deepEqual(readdirSync(paths.windows), ["4000000.json"]);
  const list = runCli(["list", "--json"], { env });
  assert.equal(list.code, 0);
  const data = JSON.parse(list.stdout);
  assert.equal(data.lost.length, 1);
  assert.equal(data.lost[0].state, "running");
  assert.equal(data.lost[0].cwd, app);

  const dry = runCli(["restore", "--dry-run"], { env });
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(
    dry.stdout,
    /1 Claude Code window was open when the computer stopped/,
  );
  assert.match(dry.stdout, /Payments refactor/);
  assert.match(dry.stdout, /was working/);
  // The command as it will run (wrapped to the screen's width).
  const command = dry.stdout.replace(/\s+/g, " ");
  assert.match(
    command,
    new RegExp(
      `claude --resume ${SESSION} --model claude-opus-5-5 --effort high --permission-mode plan`,
    ),
  );
  assert.match(dry.stdout, /opens in /);
  assert.match(dry.stdout, /Dry run: nothing was opened/);
  assert.match(dry.stdout, /Apply +osiris restore --yes/);
  // A dry run changes nothing: it is offered again.
  assert.equal(readJson(join(paths.windows, "4000000.json")).handled, null);
});

test("--print shows the commands; without a terminal nothing opens unasked", (t) => {
  const { env, app } = crashedHome(t);
  const printed = runCli(["restore", "--print"], { env });
  assert.equal(printed.code, 0, printed.stderr);
  assert.match(printed.stdout, /# Payments refactor/);
  assert.ok(printed.stdout.includes(app));

  const asked = runCli([], { env });
  assert.equal(asked.code, 0);
  assert.match(asked.stdout, /\[x\]/);
  assert.match(asked.stdout, /osiris restore --yes/);

  const json = JSON.parse(
    runCli(["restore", "--dry-run", "--json"], { env }).stdout,
  );
  assert.equal(json.windows[0].session, SESSION);
  assert.equal(json.windows[0].ticked, true);
  assert.equal(json.windows[0].beforeBoot, true);
});

test("an exited window is not offered, and nothing to restore says so", (t) => {
  const { home } = tempHome(t);
  const env = testEnv(home, {
    CLAUDE_CODE_ENTRYPOINT: "cli",
    CLAUDE_PID: "4000001",
  });
  runCli(["record", "session-start"], {
    env,
    input: JSON.stringify({ session_id: OTHER, cwd: home, source: "startup" }),
  });
  runCli(["record", "session-end"], {
    env,
    input: JSON.stringify({ session_id: OTHER, reason: "prompt_input_exit" }),
  });
  const result = runCli(["restore", "--yes"], { env: testEnv(home) });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /hooks are not installed/);
  assert.match(
    runCli(["list", "--all"], { env: testEnv(home) }).stdout,
    /CLOSED/,
  );
});

test("a window closed from outside comes back; one never prompted starts fresh", (t) => {
  const { home, paths } = tempHome(t);
  const app = join(home, "app");
  mkdirSync(app, { recursive: true });
  // Ended with Task Manager's End task (or its X) before its first prompt,
  // so it has no transcript.
  const env = testEnv(home, {
    CLAUDE_CODE_ENTRYPOINT: "cli",
    CLAUDE_PID: "4000002",
    CLAUDE_PROJECT_DIR: app,
  });
  const input = (extra) =>
    JSON.stringify({
      session_id: SESSION,
      transcript_path: join(home, "none", `${SESSION}.jsonl`),
      ...extra,
    });
  runCli(["record", "session-start"], {
    env,
    input: input({ source: "startup" }),
  });
  // It had been open a minute.
  const file = join(paths.windows, "4000002.json");
  const record = readJson(file);
  write(file, {
    ...record,
    firstSeen: new Date(Date.parse(record.firstSeen) - 60e3).toISOString(),
  });
  runCli(["record", "session-end"], { env, input: input({ reason: "other" }) });
  const result = runCli(["restore", "--dry-run"], { env: testEnv(home) });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /closed without exiting/);
  assert.match(result.stdout, /New conversation/);
  assert.doesNotMatch(result.stdout, /--resume/);
  assert.match(result.stdout, /^ +claude$/m);
});

test("install, doctor and uninstall work on ~/.claude/settings.json", (t) => {
  const { home, paths } = tempHome(t);
  const env = testEnv(home);
  const dry = runCli(["install", "--dry-run"], { env });
  assert.equal(dry.code, 0);
  assert.match(dry.stdout, /Hooks +will add/);
  assert.match(dry.stdout, /Dry run: nothing was written/);
  assert.doesNotMatch(dry.stdout, /"record"/);
  assert.match(
    runCli(["install", "--dry-run", "--diff"], { env }).stdout,
    /\+ .*"record"/,
  );
  const installed = runCli(["install"], { env });
  assert.equal(installed.code, 0, installed.stderr);
  assert.match(installed.stdout, /Hooks +added/);
  assert.match(installed.stdout, /\+ Installed/);
  assert.match(installed.stdout, /Next +osiris doctor/);
  assert.match(
    readFileSync(join(paths.claudeDir, "settings.json"), "utf8"),
    /"record"/,
  );
  assert.match(
    runCli(["install"], { env }).stdout,
    /Already installed\. Nothing to change/,
  );

  const doctor = JSON.parse(runCli(["doctor", "--json"], { env }).stdout);
  assert.equal(doctor.settings.ok, true);
  assert.match(runCli(["doctor"], { env }).stdout, /\+ settings\.json/);

  assert.equal(runCli(["uninstall"], { env }).code, 0);
  assert.doesNotMatch(
    readFileSync(join(paths.claudeDir, "settings.json"), "utf8"),
    /"record"/,
  );
});

test("scan finds a conversation from its transcript", (t) => {
  const { home, paths, root } = tempHome(t);
  const app = join(home, "app");
  mkdirSync(app, { recursive: true });
  write(
    join(paths.claudeDir, "projects", "x", `${SESSION}.jsonl`),
    jsonl([
      { type: "user", cwd: app, entrypoint: "cli" },
      { type: "ai-title", aiTitle: "Scanned one" },
    ]),
  );
  const env = withPrograms(testEnv(home), root);
  const result = runCli(["scan", "--until", "now", "--dry-run", "--baton"], {
    env,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Scanned one/);
  assert.match(result.stdout, new RegExp(`baton --resume ${SESSION}`));
  assert.equal(runCli(["scan", "--hours", "zero"], { env }).code, 2);
});

test("help, version and usage errors", (t) => {
  const { home } = tempHome(t);
  const env = testEnv(home);
  assert.match(runCli(["help"], { env }).stdout, /restore/);
  assert.doesNotMatch(runCli(["help"], { env }).stdout, /record/);
  assert.match(runCli(["--version"], { env }).stdout, /^\d+\.\d+\.\d+\n$/);
  assert.match(runCli(["scan", "--help"], { env }).stdout, /osiris scan/);
  assert.equal(runCli(["nope"], { env }).code, 2);
  assert.equal(runCli(["restore", "--bogus"], { env }).code, 2);
  assert.equal(runCli(["restore", "--wt", "--print"], { env }).code, 2);
  // The hook never fails, whatever it is given.
  assert.equal(runCli(["record", "stop"], { env, input: "not json" }).code, 0);
});
