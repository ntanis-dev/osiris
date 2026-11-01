import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { projectKey, projectRoots, scanTranscripts } from "../src/scan.js";
import { H, OTHER, SESSION, jsonl, tempHome, write } from "./helpers.js";

const NOW = Date.parse("2026-10-31T12:00:00Z");

test("a project folder is named after the folder Claude Code ran in", () => {
  assert.equal(
    projectKey("E:\\GitHub\\ntanis-dev\\baton"),
    "E--GitHub-ntanis-dev-baton",
  );
  assert.equal(projectKey("/home/me/my app"), "-home-me-my-app");
});

test("each real projects folder is read once, under the first profile naming it", (t) => {
  const { paths, home } = tempHome(t);
  const shared = join(paths.claudeDir, "projects");
  mkdirSync(shared, { recursive: true });
  const linked = join(paths.batonAccounts, "work");
  mkdirSync(linked, { recursive: true });
  symlinkSync(shared, join(linked, "projects"), "junction");
  const own = join(home, "profiles", "solo");
  mkdirSync(join(own, "projects"), { recursive: true });
  const roots = projectRoots(paths, [{ configDir: own }, { configDir: null }]);
  assert.deepEqual(
    roots.map((r) => r.configDir),
    [null, own],
  );
});

test("the scan offers terminal conversations written to in the span, newest first", (t) => {
  const { paths, home } = tempHome(t);
  const projects = join(paths.claudeDir, "projects");
  const app = join(home, "work", "app");
  mkdirSync(app, { recursive: true });
  const dir = join(projects, projectKey(app));
  const transcript = (session, entries, mtime) =>
    write(join(dir, `${session}.jsonl`), jsonl(entries), mtime);
  transcript(
    SESSION,
    [
      { type: "user", cwd: app, entrypoint: "cli" },
      { type: "user", cwd: join(app, "sub"), entrypoint: "cli" },
      { type: "ai-title", aiTitle: "First" },
    ],
    NOW - 2 * H,
  );
  transcript(OTHER, [{ type: "user", cwd: app, entrypoint: "cli" }], NOW - H);
  transcript(
    "too-old",
    [{ type: "user", cwd: app, entrypoint: "cli" }],
    NOW - 5 * H,
  );
  transcript(
    "from-sdk",
    [{ type: "user", cwd: app, entrypoint: "sdk-cli" }],
    NOW - H,
  );
  transcript(
    "went-on",
    [
      { type: "user", cwd: app, entrypoint: "cli" },
      { type: "continued-in", continuedInSessionId: OTHER },
    ],
    NOW - H,
  );
  transcript(
    "open-now",
    [{ type: "user", cwd: app, entrypoint: "cli" }],
    NOW - H,
  );
  write(
    join(dir, SESSION, "subagents", "agent-1.jsonl"),
    jsonl([{ type: "user" }]),
    NOW - H,
  );

  const found = scanTranscripts(projectRoots(paths), {
    from: NOW - 3 * H,
    to: NOW,
    skip: new Set(["open-now"]),
  });
  assert.deepEqual(
    found.map((w) => w.session),
    [OTHER, SESSION],
  );
  const first = found[1];
  // The folder whose name matches the project, not where it moved to.
  assert.equal(first.cwd, app);
  assert.equal(first.info.title, "First");
  assert.equal(first.configDir, null);
  assert.equal(first.scanned, true);
});
