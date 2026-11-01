import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  aliveCheck,
  classify,
  listWindows,
  markHandled,
  pruneWindows,
} from "../src/windows.js";
import { H, M, OTHER, SESSION, tempHome, write } from "./helpers.js";

const NOW = Date.parse("2026-10-31T12:00:00Z");
const BOOT = NOW - 10 * M;
const at = (t) => new Date(t).toISOString();

const window = (pid, extra = {}) => ({
  pid,
  firstSeen: at(BOOT - 3 * H),
  lastSeen: at(BOOT - 5 * M),
  session: SESSION,
  wrapper: null,
  end: null,
  handled: null,
  ...extra,
});

const aliveOnly =
  (...pids) =>
  (w) =>
    pids.includes(w.pid);

test("windows sort into live, closed and lost; lost ones say if they predate the boot", () => {
  const groups = classify(
    [
      window(1, { session: "a" }),
      window(2, {
        session: "b",
        end: { at: at(BOOT - H), reason: "prompt_input_exit" },
      }),
      window(3, { session: "c", lastSeen: at(BOOT + M) }),
      window(4, { session: "d", lastSeen: at(BOOT - 2 * H) }),
      // Gone between a /clear's end and its next start: still lost.
      window(5, { session: "e", end: { at: at(BOOT - H), reason: "clear" } }),
    ],
    { alive: aliveOnly(1), bootAt: BOOT },
  );
  assert.deepEqual(
    groups.live.map((w) => w.pid),
    [1],
  );
  assert.deepEqual(
    groups.closed.map((w) => w.pid),
    [2],
  );
  // Newest first.
  assert.deepEqual(
    groups.lost.map((w) => [w.pid, w.beforeBoot]),
    [
      [3, false],
      [5, true],
      [4, true],
    ],
  );
});

const closedAt = (t, extra = {}) => ({
  lastSeen: at(t),
  end: { at: at(t), reason: "other" },
  ...extra,
});
const pids = (list) => list.map((w) => w.pid).sort((a, b) => a - b);

test("windows closed from outside come back with the last ones closed together", () => {
  const groups = classify(
    [
      // The last closing since the start: two windows within five minutes.
      window(1, { session: "a", ...closedAt(NOW - M) }),
      window(2, { session: "b", ...closedAt(NOW - 4 * M) }),
      // Closed earlier, on its own.
      window(3, { session: "c", ...closedAt(NOW - 8 * M) }),
      // Exited at its prompt.
      window(4, {
        session: "d",
        lastSeen: at(NOW - 2 * M),
        end: { at: at(NOW - 2 * M), reason: "prompt_input_exit" },
      }),
    ],
    { alive: () => false, bootAt: BOOT },
  );
  assert.deepEqual(pids(groups.lost), [1, 2]);
  assert.ok(groups.lost.every((w) => !w.beforeBoot));
  assert.deepEqual(pids(groups.closed), [3, 4]);
});

test("the windows a restart closed come back as lost in it", () => {
  const records = [
    // Windows closed them all as it restarted, five minutes before the boot.
    window(1, { session: "a", ...closedAt(BOOT - 5 * M) }),
    window(2, { session: "b", ...closedAt(BOOT - 5 * M - 3e3) }),
    // Closed with its X an hour earlier.
    window(3, { session: "c", ...closedAt(BOOT - 65 * M) }),
    // Closed since the start, with a lost window from before it.
    window(4, { session: "d", ...closedAt(BOOT + 5 * M) }),
    window(5, { session: "e", lastSeen: at(BOOT - 2 * H) }),
  ];
  const groups = classify(records, { alive: () => false, bootAt: BOOT });
  assert.deepEqual(pids(groups.lost), [1, 2, 4, 5]);
  assert.deepEqual(
    groups.lost.filter((w) => w.beforeBoot).map((w) => w.pid),
    [1, 2, 5],
  );
  assert.deepEqual(pids(groups.closed), [3]);

  // A window seen after the closing: the computer went on, so the restart
  // came later and did not close them (a freeze).
  const later = classify(
    [...records, window(6, { session: "f", lastSeen: at(BOOT - 2 * M) })],
    { alive: () => false, bootAt: BOOT },
  );
  assert.deepEqual(pids(later.closed), [1, 2, 3]);
  // A closing more than an hour before the start is not the restart's.
  const long = classify(records, { alive: () => false, bootAt: BOOT + H });
  assert.ok(long.closed.some((w) => w.pid === 1));
});

test("a window that ended at once before any prompt was never open", () => {
  const brief = window(1, {
    firstSeen: at(NOW - 2e3),
    ...closedAt(NOW - 1e3),
  });
  const kept = window(2, { session: "b", ...closedAt(NOW - 1e3) });
  const groups = classify([brief, kept], {
    alive: () => false,
    bootAt: BOOT,
    conversation: (w) => w.pid !== 1,
  });
  assert.deepEqual(pids(groups.closed), [1]);
  assert.deepEqual(pids(groups.lost), [2]);
});

test("a lost window whose conversation went on elsewhere is superseded", () => {
  const groups = classify(
    [
      // Open again in a live window.
      window(1, { session: SESSION }),
      window(2, { session: SESSION, lastSeen: at(NOW) }),
      // Resumed later in another window that has exited since.
      window(3, { session: OTHER, lastSeen: at(BOOT - H) }),
      window(4, {
        session: OTHER,
        lastSeen: at(BOOT + M),
        end: { at: at(BOOT + M), reason: "prompt_input_exit" },
      }),
      // Baton moved the wrapper's conversation to another process.
      window(5, { session: "x", wrapper: "w1", lastSeen: at(BOOT - H) }),
      window(6, { session: "y", wrapper: "w1", lastSeen: at(BOOT - 30 * M) }),
    ],
    { alive: aliveOnly(2), bootAt: BOOT },
  );
  assert.deepEqual(groups.superseded.map((w) => w.pid).sort(), [1, 3, 5]);
  assert.deepEqual(
    groups.lost.map((w) => w.pid),
    [6],
  );
});

test("a restored or dismissed window is offered again only with all", () => {
  const records = [
    window(1, { handled: { at: at(NOW), action: "dismissed" } }),
  ];
  assert.equal(
    classify(records, { alive: () => false, bootAt: BOOT }).lost.length,
    0,
  );
  assert.equal(
    classify(records, { alive: () => false, bootAt: BOOT, all: true }).lost
      .length,
    1,
  );
});

test("a process counts as the window's only if it started before the window was seen", () => {
  const firstSeen = BOOT - H;
  const w = window(7, { firstSeen: at(firstSeen) });
  const running = (startedAt) => new Map([[7, { startedAt }]]);
  assert.equal(aliveCheck(running(firstSeen - M), { bootAt: BOOT })(w), true);
  assert.equal(aliveCheck(running(null), { bootAt: BOOT })(w), true);
  assert.equal(
    aliveCheck(running(firstSeen + 10 * M), { bootAt: BOOT })(w),
    false,
  );
  assert.equal(aliveCheck(new Map(), { bootAt: BOOT })(w), false);
  // Without a process list: alive only if seen since the boot.
  const me = window(process.pid, { lastSeen: at(Date.now()) });
  assert.equal(aliveCheck(null, { bootAt: Date.now() - H })(me), true);
  assert.equal(aliveCheck(null, { bootAt: Date.now() + H })(me), false);
});

test("records are listed with their files, marked, and pruned when old", (t) => {
  const { paths } = tempHome(t);
  write(
    join(paths.windows, "1.json"),
    window(1, {
      lastSeen: at(NOW - 20 * 864e5),
      end: { at: at(NOW - 20 * 864e5), reason: "prompt_input_exit" },
    }),
  );
  write(
    join(paths.windows, "2-100.json"),
    window(2, { lastSeen: at(NOW - 20 * 864e5) }),
  );
  write(
    join(paths.windows, "3.json"),
    window(3, { lastSeen: at(NOW - 70 * 864e5) }),
  );
  write(join(paths.windows, "notes.txt"), "not a record");
  write(join(paths.windows, "4.json"), "{ torn");
  const windows = listWindows(paths);
  assert.deepEqual(windows.map((w) => w.pid).sort(), [1, 2, 3]);
  markHandled(
    windows.filter((w) => w.pid === 2),
    "restored",
    NOW,
  );
  const again = listWindows(paths);
  assert.equal(again.find((w) => w.pid === 2).handled.action, "restored");

  const groups = classify(again, { alive: () => false, bootAt: BOOT });
  assert.equal(pruneWindows(groups, NOW), 3);
  assert.equal(existsSync(join(paths.windows, "1.json")), false);
  assert.equal(existsSync(join(paths.windows, "2-100.json")), false);
  assert.equal(existsSync(join(paths.windows, "3.json")), false);
});

test("a recent lost window is kept by the pruning", (t) => {
  const { paths } = tempHome(t);
  write(
    join(paths.windows, "1.json"),
    window(1, { lastSeen: at(NOW - 20 * 864e5) }),
  );
  const groups = classify(listWindows(paths), {
    alive: () => false,
    bootAt: BOOT,
  });
  assert.equal(pruneWindows(groups, NOW), 0);
});
