import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseElapsed,
  parsePs,
  parseWin32,
  runningProcesses,
} from "../src/processes.js";

test("ps elapsed times and both process lists parse", () => {
  assert.equal(parseElapsed("05:07"), 307);
  assert.equal(parseElapsed("02:05:07"), 7507);
  assert.equal(parseElapsed("3-02:05:07"), 266707);
  assert.equal(parseElapsed("soon"), null);
  const now = 1_000_000_000;
  assert.deepEqual(
    [...parsePs("  41  01:00\n 7 1-00:00:00\n", now)],
    [
      [41, { startedAt: now - 60e3 }],
      [7, { startedAt: now - 864e5 }],
    ],
  );
  assert.deepEqual(
    [...parseWin32("16076 2026-10-31T15:05:47.4891207Z\r\n12 later\r\n\r\n")],
    [
      [16076, { startedAt: Date.parse("2026-10-31T15:05:47.489Z") }],
      [12, { startedAt: null }],
    ],
  );
});

test("one query for all the processes, and null when it fails", () => {
  const seen = [];
  const run = (file, args) => {
    seen.push([file, args.at(-1)]);
    return { status: 0, stdout: "5 2026-10-31T10:00:00Z\n" };
  };
  const win = runningProcesses([5, 5, 6, -1, 1.5], { platform: "win32", run });
  assert.deepEqual([...win.keys()], [5]);
  assert.equal(seen[0][0], "powershell.exe");
  assert.match(seen[0][1], /-Filter 'ProcessId=5 OR ProcessId=6'/);

  const ps = runningProcesses([5], {
    platform: "linux",
    run: () => ({ status: 1, stdout: " 5 00:10\n" }),
    now: 100e3,
  });
  assert.deepEqual([...ps], [[5, { startedAt: 90e3 }]]);
  assert.equal(
    runningProcesses([5], {
      platform: "linux",
      run: () => ({ status: 2, stdout: "" }),
    }),
    null,
  );
  assert.equal(
    runningProcesses([5], {
      platform: "win32",
      run: () => ({ error: new Error("x") }),
    }),
    null,
  );
  assert.deepEqual([...runningProcesses([], { run: () => assert.fail() })], []);
});

test("this very process is found with a start time in the past", () => {
  const found = runningProcesses([process.pid]);
  assert.ok(found, "the process list could be read");
  const me = found.get(process.pid);
  assert.ok(me);
  assert.ok(me.startedAt <= Date.now() + 2000);
});
