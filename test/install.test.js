import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  InstallError,
  applyPlan,
  hookState,
  isOsirisHandler,
  planInstall,
  planIsNoop,
  planUninstall,
  settingsPath,
} from "../src/install.js";
import { tempHome, write } from "./helpers.js";

const NODE = "C:/node/node.exe";
const CLI = "C:/tools/osiris/src/cli.js";

// Baton's own handler: the same exec form with "hook" instead of "record".
const batonHandler = {
  type: "command",
  command: NODE,
  args: ["C:/tools/baton/src/cli.js", "hook", "session-start"],
  timeout: 10,
};

test("install adds one exec-form hook per event and keeps everything else", (t) => {
  const { paths } = tempHome(t);
  const file = settingsPath(paths);
  write(file, {
    model: "opus",
    hooks: {
      SessionStart: [{ hooks: [batonHandler] }],
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "mine" }] },
      ],
    },
  });
  const plan = planInstall({ paths, nodePath: NODE, cliPath: CLI });
  assert.equal(plan.action, "add");
  applyPlan(plan, { paths, now: 0 });
  const settings = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(settings.model, "opus");
  assert.deepEqual(settings.hooks.PreToolUse, [
    { matcher: "Bash", hooks: [{ type: "command", command: "mine" }] },
  ]);
  assert.deepEqual(settings.hooks.SessionStart[0], { hooks: [batonHandler] });
  for (const [event, name] of [
    ["SessionStart", "session-start"],
    ["UserPromptSubmit", "prompt"],
    ["Stop", "stop"],
    ["StopFailure", "stop-failure"],
    ["SessionEnd", "session-end"],
  ]) {
    const ours = settings.hooks[event]
      .flatMap((g) => g.hooks)
      .filter(isOsirisHandler);
    assert.deepEqual(ours, [
      {
        type: "command",
        command: NODE,
        args: [CLI, "record", name],
        timeout: 10,
      },
    ]);
  }
  assert.equal(isOsirisHandler(batonHandler), false);
  // A backup of the file as it was, and the record of the install.
  assert.equal(readdirSync(paths.backups).length, 1);
  assert.equal(JSON.parse(readFileSync(paths.install, "utf8")).cli, CLI);

  // Running it again changes nothing.
  const again = planInstall({ paths, nodePath: NODE, cliPath: CLI });
  assert.equal(again.action, "same");
  assert.equal(planIsNoop(again, paths), true);
  assert.equal(applyPlan(again, { paths }).changed, false);

  // A moved checkout updates the hooks in place.
  const moved = planInstall({
    paths,
    nodePath: NODE,
    cliPath: "D:/k/src/cli.js",
  });
  assert.equal(moved.action, "update");
  applyPlan(moved, { paths, now: 1000 });
  const after = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(
    after.hooks.Stop.flatMap((g) => g.hooks).filter(isOsirisHandler).length,
    1,
  );
});

test("uninstall removes exactly Osiris's hooks", (t) => {
  const { paths } = tempHome(t);
  const file = settingsPath(paths);
  write(file, { hooks: { SessionStart: [{ hooks: [batonHandler] }] } });
  applyPlan(planInstall({ paths, nodePath: NODE, cliPath: CLI }), { paths });
  const plan = planUninstall({ paths });
  assert.equal(plan.action, "remove");
  applyPlan(plan, { paths });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
    hooks: { SessionStart: [{ hooks: [batonHandler] }] },
  });
  assert.equal(existsSync(paths.install), false);
  assert.equal(planUninstall({ paths }).action, "absent");
});

test("a new settings file is created, and an invalid one is refused", (t) => {
  const { paths } = tempHome(t);
  applyPlan(planInstall({ paths, nodePath: NODE, cliPath: CLI }), { paths });
  assert.ok(
    JSON.parse(readFileSync(settingsPath(paths), "utf8")).hooks.SessionEnd,
  );
  assert.equal(existsSync(paths.backups), false);
  write(settingsPath(paths), "{ not json");
  assert.throws(
    () => planInstall({ paths, nodePath: NODE, cliPath: CLI }),
    InstallError,
  );
});

test("the hook state says which events are covered", (t) => {
  const { paths } = tempHome(t);
  const file = settingsPath(paths);
  assert.equal(hookState(file).events.Stop.installed, false);
  applyPlan(
    planInstall({
      paths,
      nodePath: process.execPath,
      cliPath: join(paths.home, "src", "cli.js"),
    }),
    { paths },
  );
  const state = hookState(file);
  assert.equal(state.ok, true);
  assert.equal(state.events.Stop.installed, true);
  assert.equal(state.events.Stop.nodeExists, true);
  assert.equal(state.events.Stop.cliExists, false);
  write(file, "{");
  assert.equal(hookState(file).ok, false);
});
