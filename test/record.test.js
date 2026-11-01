import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join, normalize } from "node:path";
import { handleRecord } from "../src/record.js";
import { readJson } from "../src/fsutil.js";
import { windowFile } from "../src/windows.js";
import { M, OTHER, SESSION, hookEnv, tempHome } from "./helpers.js";

const T0 = Date.parse("2026-10-31T10:00:00Z");

function recorder(t) {
  const { paths, home } = tempHome(t);
  const record = (event, input, env = hookEnv(4242), now = T0) =>
    handleRecord(event, { session_id: SESSION, ...input }, { env, paths, now });
  return { paths, home, record };
}

test("a session start records the window, its profile, wrapper and terminal", (t) => {
  const { paths, home, record } = recorder(t);
  const project = join(home, "work", "app");
  const written = record(
    "session-start",
    {
      source: "startup",
      cwd: join(project, "sub"),
      transcript_path: "t.jsonl",
    },
    hookEnv(4242, {
      CLAUDE_PROJECT_DIR: project.replace(/\\/g, "/"),
      CLAUDE_CONFIG_DIR: join(home, ".baton", "accounts", "work"),
      BATON_WRAPPER: "1234-abcdef01",
      WT_SESSION: "x",
      WT_PROFILE_ID: "{61c54bbd-c2c6-5271-96e7-009a87ff44bf}",
    }),
  );
  assert.equal(written.pid, 4242);
  assert.equal(written.cwd, normalize(project));
  assert.equal(written.transcript, "t.jsonl");
  assert.equal(written.wrapper, "1234-abcdef01");
  assert.equal(written.configDir, join(home, ".baton", "accounts", "work"));
  assert.deepEqual(written.terminal, {
    kind: "wt",
    profile: "{61c54bbd-c2c6-5271-96e7-009a87ff44bf}",
  });
  assert.equal(written.firstSeen, new Date(T0).toISOString());
  assert.deepEqual(readJson(windowFile(paths, 4242)), written);
});

test("only interactive sessions with a process id and a session id count", (t) => {
  const { paths, record } = recorder(t);
  assert.equal(
    record(
      "session-start",
      { source: "startup" },
      hookEnv(1, { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }),
    ),
    null,
  );
  assert.equal(
    record("session-start", {}, { CLAUDE_CODE_ENTRYPOINT: "cli" }),
    null,
  );
  assert.equal(record("session-start", { session_id: "../x" }), null);
  assert.equal(record("no-such-event", {}), null);
  assert.equal(handleRecord("stop", null, { env: hookEnv(1), paths }), null);
  assert.equal(existsSync(paths.windows), false);
});

test("prompts and stops track whether a turn runs, its mode and effort", (t) => {
  const { record } = recorder(t);
  record("session-start", { source: "startup" });
  let w = record("prompt", { permission_mode: "plan" }, undefined, T0 + M);
  assert.equal(w.state, "running");
  assert.equal(w.permissionMode, "plan");
  w = record(
    "stop",
    { permission_mode: "auto", effort: { level: "xhigh" } },
    undefined,
    T0 + 2 * M,
  );
  assert.equal(w.state, "idle");
  assert.equal(w.permissionMode, "auto");
  assert.equal(w.effort, "xhigh");
  assert.equal(w.firstSeen, new Date(T0).toISOString());
  assert.equal(w.lastSeen, new Date(T0 + 2 * M).toISOString());
});

test("/clear and /resume keep the window and move it to the next session", (t) => {
  const { paths, record } = recorder(t);
  record("session-start", { source: "startup" });
  record("session-end", { reason: "clear" }, undefined, T0 + M);
  const w = handleRecord(
    "session-start",
    { session_id: OTHER, source: "clear" },
    { env: hookEnv(4242), paths, now: T0 + M + 500 },
  );
  assert.equal(w.session, OTHER);
  assert.equal(w.end, null);
  assert.equal(w.firstSeen, new Date(T0).toISOString());
  assert.deepEqual(readdirSync(paths.windows), ["4242.json"]);

  handleRecord(
    "session-end",
    { session_id: OTHER, reason: "resume" },
    { env: hookEnv(4242), paths, now: T0 + 2 * M },
  );
  const back = record(
    "session-start",
    { source: "resume" },
    undefined,
    T0 + 2 * M + 300,
  );
  assert.equal(back.session, SESSION);
  assert.equal(back.end, null);
  assert.deepEqual(readdirSync(paths.windows), ["4242.json"]);
});

test("an exit ends the window; the end of a session it left changes nothing", (t) => {
  const { record } = recorder(t);
  record("session-start", { source: "startup" });
  const ignored = record("session-end", { session_id: OTHER, reason: "other" });
  assert.equal(ignored.session, SESSION);
  assert.equal(ignored.end, null);
  const w = record(
    "session-end",
    { reason: "prompt_input_exit" },
    undefined,
    T0 + M,
  );
  assert.deepEqual(w.end, {
    at: new Date(T0 + M).toISOString(),
    reason: "prompt_input_exit",
  });
});

test("a new process with a reused id keeps the old record under its own name", (t) => {
  const { paths, record } = recorder(t);
  record("session-start", { source: "startup" });
  record("prompt", {}, undefined, T0 + M);
  // A crash: no SessionEnd. The id comes back in a process resumed later.
  const w = handleRecord(
    "session-start",
    { session_id: OTHER, source: "resume" },
    { env: hookEnv(4242), paths, now: T0 + 60 * M },
  );
  assert.equal(w.session, OTHER);
  assert.equal(w.firstSeen, new Date(T0 + 60 * M).toISOString());
  const names = readdirSync(paths.windows).sort();
  assert.deepEqual(names, [`4242-${T0}.json`, "4242.json"]);
  const old = readJson(join(paths.windows, `4242-${T0}.json`));
  assert.equal(old.session, SESSION);
  assert.equal(old.state, "running");

  // A fresh start always begins a new window, even right after an exit.
  record(
    "session-end",
    { session_id: OTHER, reason: "clear" },
    undefined,
    T0 + 61 * M,
  );
  handleRecord(
    "session-start",
    { session_id: OTHER, source: "startup" },
    {
      env: hookEnv(4242),
      paths,
      now: T0 + 61 * M + 100,
    },
  );
  assert.equal(readdirSync(paths.windows).length, 3);
});

test("a compaction keeps the window", (t) => {
  const { paths, record } = recorder(t);
  record("session-start", { source: "startup" });
  record("session-start", { source: "compact" }, undefined, T0 + 5 * M);
  assert.deepEqual(readdirSync(paths.windows), ["4242.json"]);
});

test("a window first seen at a prompt (installed mid-session) is recorded", (t) => {
  const { record } = recorder(t);
  const w = record("prompt", { cwd: "/somewhere" });
  assert.equal(w.state, "running");
  assert.equal(w.cwd, normalize("/somewhere"));
});
