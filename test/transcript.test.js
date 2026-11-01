import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { transcriptInfo } from "../src/transcript.js";
import { SESSION, jsonl, tempHome, write } from "./helpers.js";

const entry = (type, extra = {}) => ({ type, sessionId: SESSION, ...extra });

test("a transcript gives the title, model, effort, mode and folder it ended with", (t) => {
  const { root } = tempHome(t);
  const file = join(root, "t.jsonl");
  write(
    file,
    jsonl([
      entry("user", {
        cwd: "E:\\one",
        entrypoint: "cli",
        permissionMode: "default",
        timestamp: "2026-10-31T10:00:00Z",
      }),
      entry("assistant", {
        requestedModel: "claude-opus-5-5[1m]",
        message: { model: "claude-opus-5-5" },
        effort: "xhigh",
        cwd: "E:\\one\\sub",
      }),
      entry("assistant", { message: { model: "<synthetic>" } }),
      entry("last-prompt", { lastPrompt: "fix   the\nbuild" }),
      entry("ai-title", { aiTitle: "Build repair" }),
      entry("permission-mode", { permissionMode: "plan" }),
      entry("system", { timestamp: "2026-10-31T10:05:00Z" }),
    ]),
  );
  const info = transcriptInfo(file);
  assert.equal(info.title, "Build repair");
  assert.equal(info.model, "claude-opus-5-5[1m]");
  assert.equal(info.effort, "xhigh");
  assert.equal(info.permissionMode, "plan");
  assert.equal(info.cwd, "E:\\one\\sub");
  assert.deepEqual(info.cwds, ["E:\\one", "E:\\one\\sub"]);
  assert.equal(info.entrypoint, "cli");
  assert.equal(info.lastAt, "2026-10-31T10:05:00Z");
  assert.equal(info.continuedIn, null);
});

test("a /rename title wins, the last prompt is the last resort", (t) => {
  const { root } = tempHome(t);
  const file = join(root, "t.jsonl");
  write(
    file,
    jsonl([
      entry("ai-title", { aiTitle: "Theirs" }),
      entry("custom-title", { customTitle: "Mine" }),
    ]),
  );
  assert.equal(transcriptInfo(file).title, "Mine");
  write(file, jsonl([entry("last-prompt", { lastPrompt: "x".repeat(200) })]));
  const title = transcriptInfo(file).title;
  assert.equal(title.length, 80);
  assert.ok(title.endsWith("…"));
});

test("only the end of a long transcript is read, and a cut line is skipped", (t) => {
  const { root } = tempHome(t);
  const file = join(root, "t.jsonl");
  write(
    file,
    jsonl([
      entry("custom-title", { customTitle: "Early" }),
      entry("user", { message: { content: "y".repeat(5000) } }),
      entry("ai-title", { aiTitle: "Late" }),
      entry("continued-in", { continuedInSessionId: "next-session" }),
    ]),
  );
  const info = transcriptInfo(file, { bytes: 300 });
  assert.equal(info.title, "Late");
  assert.equal(info.continuedIn, "next-session");
  assert.equal(transcriptInfo(join(root, "missing.jsonl")), null);
});
