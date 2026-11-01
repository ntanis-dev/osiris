import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import {
  cleanEnv,
  commandLines,
  planLaunch,
  posixScript,
  resumeCommand,
  runLaunch,
  safeTitle,
  scriptSafe,
  terminalFor,
  which,
  windowsScript,
} from "../src/launch.js";
import { withCommands } from "../src/restore.js";
import { SESSION, tempHome, write } from "./helpers.js";

const base = {
  session: SESSION,
  cwd: "C:\\work\\app",
  configDir: null,
  wrapper: null,
  effort: null,
  permissionMode: null,
  terminal: { kind: "console", profile: null },
};
const info = {
  title: "Fix the build",
  model: "claude-opus-5-5[1m]",
  effort: "high",
  permissionMode: "plan",
};

test("a plain window resumes in claude under its profile, with its model, effort and mode", () => {
  const c = resumeCommand(
    { ...base, configDir: "C:\\p\\one", effort: "xhigh" },
    info,
  );
  assert.equal(c.via, "claude");
  assert.deepEqual(c.args, [
    "--resume",
    SESSION,
    "--model",
    "claude-opus-5-5[1m]",
    "--effort",
    "xhigh",
    "--permission-mode",
    "plan",
  ]);
  assert.equal(c.configDir, "C:\\p\\one");
  assert.equal(c.cwd, "C:\\work\\app");
  assert.equal(c.title, "Fix the build");
});

test("a Baton window goes back through baton, or plain claude without Baton", () => {
  const w = { ...base, wrapper: "1-ab", configDir: "C:\\b\\acct" };
  const c = resumeCommand(w, null);
  assert.equal(c.via, "baton");
  assert.deepEqual(c.args, ["--resume", SESSION]);
  assert.equal(c.configDir, null);
  const plain = resumeCommand(w, null, { baton: false });
  assert.equal(plain.via, "claude");
  assert.equal(plain.configDir, "C:\\b\\acct");
  assert.equal(resumeCommand({ ...base, viaBaton: true }, null).via, "baton");
});

test("odd values are left out and the default mode is not passed", () => {
  const c = resumeCommand(
    { ...base, permissionMode: "default" },
    { model: "x & del *", effort: "high;rm" },
  );
  assert.deepEqual(c.args, ["--resume", SESSION]);
  assert.equal(c.title, SESSION);
  assert.equal(safeTitle('a & b | "c" %PATH% ^ ; d'), "a b c PATH d");
  assert.equal(safeTitle("\u0000"), "Claude Code");
});

test("the Windows script changes folder, sets the profile and calls the program", () => {
  const script = windowsScript({
    title: "Fix",
    cwd: "C:\\work\\100% app",
    configDir: "C:\\p\\one",
    program: "claude",
    args: ["--resume", SESSION],
  });
  assert.equal(
    script,
    [
      "@title Fix",
      '@cd /d "C:\\work\\100%% app"',
      '@set "CLAUDE_CONFIG_DIR=C:\\p\\one"',
      `@call claude --resume ${SESSION}`,
      "",
    ].join("\r\n"),
  );
  const greek = windowsScript({
    title: "Δοκιμή",
    cwd: "C:\\w",
    configDir: null,
    program: "baton",
    args: [],
  });
  assert.ok(greek.startsWith("@chcp 65001 >nul\r\n"));
  assert.ok(!greek.includes("CLAUDE_CONFIG_DIR"));
});

test("the POSIX script quotes every value and keeps a shell open", () => {
  const script = posixScript({
    title: "it's",
    cwd: "/home/me/it's here",
    configDir: null,
    program: "claude",
    args: ["--resume", SESSION],
  });
  assert.match(
    script,
    /^#!\/bin\/sh\ncd '\/home\/me\/it'\\''s here' \|\| exit 1\nunset CLAUDE_CONFIG_DIR\n/,
  );
  assert.match(script, /exec "\$\{SHELL:-\/bin\/sh\}"\n$/);
  assert.deepEqual(
    commandLines(
      {
        cwd: "/w",
        configDir: "/p",
        program: "claude",
        args: ["--resume", "x"],
      },
      "linux",
    ),
    ["cd '/w'", "CLAUDE_CONFIG_DIR='/p' claude --resume x"],
  );
  assert.deepEqual(
    commandLines(
      { cwd: "C:\\w", configDir: null, program: "baton", args: [] },
      "win32",
    ),
    ['cd /d "C:\\w"', "baton"],
  );
});

test("windows go back to a terminal like theirs", () => {
  const wt = { ...base, terminal: { kind: "wt", profile: null } };
  assert.equal(
    terminalFor(wt, { platform: "win32", env: {}, wt: "wt.exe" }),
    "wt",
  );
  assert.equal(
    terminalFor(wt, { platform: "win32", env: {}, wt: null }),
    "console",
  );
  assert.equal(
    terminalFor(base, { platform: "win32", env: {}, wt: "wt.exe" }),
    "console",
  );
  assert.equal(
    terminalFor(base, { platform: "linux", env: { TMUX: "1" } }),
    "tmux",
  );
  assert.equal(terminalFor(base, { platform: "darwin", env: {} }), "print");
  assert.equal(
    terminalFor(wt, { mode: "console", platform: "win32", env: {} }),
    "console",
  );
});

test("a folder name that could end the quotes of a batch line is never put in a script", () => {
  for (const hostile of ['D:/p" & calc & "', "D:/p\r\nrd /s /q C:/", "D:/p\0"])
    assert.equal(scriptSafe(hostile, "win32"), false, JSON.stringify(hostile));
  for (const fine of [null, "D:/my folder/(x) & y", "C:\\p\\one", "/home/a b"])
    assert.equal(scriptSafe(fine, "win32"), true, String(fine));
  // single quotes in the POSIX script hold anything
  assert.equal(scriptSafe('/home/a"b', "linux"), true);

  // the profile folder is not looked up, so a window whose profile is hostile is skipped, not opened
  const cwd = process.cwd();
  const [plain, hostile, hostileFolder] = withCommands(
    [
      { window: { ...base, cwd, configDir: "D:/p" } },
      { window: { ...base, cwd, configDir: 'D:/p" & calc & "' } },
      { window: { ...base, cwd: `${cwd}" & calc & "` } },
    ],
    { platform: "win32" },
  );
  assert.equal(plain.problem, undefined);
  assert.match(hostile.problem, /cannot be put in a script safely/);
  assert.match(hostileFolder.problem, /folder is gone/);
});

test("run inside Windows Terminal, every window comes back as a tab there", (t) => {
  const inside = { WT_SESSION: "abc" };
  assert.equal(
    terminalFor(base, { platform: "win32", env: inside, wt: "wt.exe" }),
    "wt",
  );
  // no wt on PATH, or --console: the console window it was
  assert.equal(
    terminalFor(base, { platform: "win32", env: inside, wt: null }),
    "console",
  );
  assert.equal(
    terminalFor(base, {
      mode: "console",
      platform: "win32",
      env: inside,
      wt: "wt.exe",
    }),
    "console",
  );

  const { paths } = tempHome(t);
  const entries = [
    { window: base, command: resumeCommand(base, info) },
    {
      window: {
        ...base,
        session: "s2",
        terminal: { kind: "wt", profile: null },
      },
      command: resumeCommand({ ...base, session: "s2" }, { title: "two" }),
    },
  ];
  const opened = (env) =>
    planLaunch(entries, {
      paths,
      platform: "win32",
      env,
      wt: "wt.exe",
      now: 5,
    });
  const here = opened(inside);
  assert.equal(here.spawns.length, 1, "one wt call, no console window");
  assert.deepEqual(here.spawns[0].args.slice(0, 2), ["-w", "0"]);
  assert.equal(here.spawns[0].entries.length, 2);
  // from a console window, the windows that ran in Windows Terminal get a new one
  const away = opened({});
  assert.equal(away.spawns.length, 2);
  assert.deepEqual(away.spawns[0].args.slice(0, 2), ["-w", "new"]);
  assert.equal(away.spawns[0].entries.length, 1);
});

test("the launch plan opens consoles, one Windows Terminal window of tabs, and prints the rest", (t) => {
  const { paths } = tempHome(t);
  const entries = [
    { window: base, command: resumeCommand(base, info) },
    {
      window: {
        ...base,
        session: "s2",
        terminal: { kind: "wt", profile: "{p;1}" },
      },
      command: resumeCommand(
        { ...base, session: "s2", cwd: "C:\\a;b" },
        { title: "two" },
      ),
    },
    {
      window: {
        ...base,
        session: "s3",
        terminal: { kind: "wt", profile: null },
      },
      command: resumeCommand({ ...base, session: "s3" }, { title: "three" }),
    },
  ];
  const env = {
    PATH: "x",
    CLAUDECODE: "1",
    CLAUDE_PID: "9",
    BATON_WRAPPER: "1-a",
    CLAUDE_CODE_GIT_BASH_PATH: "keep",
  };
  const plan = planLaunch(entries, {
    paths,
    platform: "win32",
    env,
    wt: "C:\\wt.exe",
    now: 5,
  });
  assert.equal(plan.spawns.length, 2);
  const [tabs, consoleWindow] = plan.spawns;
  assert.equal(tabs.file, "C:\\wt.exe");
  assert.deepEqual(tabs.args, [
    "-w",
    "new",
    "new-tab",
    "--title",
    "two",
    "-d",
    "C:\\a\\;b",
    "-p",
    "{p\\;1}",
    "cmd.exe",
    "/d",
    "/k",
    join(paths.launch, "s2-5.cmd"),
    ";",
    "new-tab",
    "--title",
    "three",
    "-d",
    "C:\\work\\app",
    "cmd.exe",
    "/d",
    "/k",
    join(paths.launch, "s3-5.cmd"),
  ]);
  assert.equal(consoleWindow.file, "cmd.exe");
  assert.deepEqual(consoleWindow.args, [
    "/d",
    "/s",
    "/c",
    `"start "Fix the build" cmd.exe /d /k "${join(paths.launch, `${SESSION}-5.cmd`)}""`,
  ]);
  assert.equal(consoleWindow.options.windowsVerbatimArguments, true);
  assert.deepEqual(consoleWindow.options.env, {
    PATH: "x",
    CLAUDE_CODE_GIT_BASH_PATH: "keep",
  });
  assert.match(
    readFileSync(entries[0].script, "utf8"),
    /@call claude --resume /,
  );

  const printed = planLaunch(
    [{ window: base, command: resumeCommand(base, info) }],
    {
      paths,
      platform: "darwin",
      env: {},
    },
  );
  assert.deepEqual(printed.spawns, []);
  assert.equal(printed.printed.length, 1);
});

test("each planned process is started in turn; one that fails is reported", async () => {
  const calls = [];
  const run = (file, args) => {
    calls.push(file);
    const child = new EventEmitter();
    child.unref = () => {};
    setImmediate(() =>
      file === "bad"
        ? child.emit("error", new Error("spawn bad ENOENT"))
        : child.emit("spawn"),
    );
    return child;
  };
  const a = {};
  const b = {};
  await runLaunch(
    {
      spawns: [
        { file: "good", args: [], entries: [a] },
        { file: "bad", args: [], entries: [b] },
      ],
    },
    { run, pause: 0 },
  );
  assert.deepEqual(calls, ["good", "bad"]);
  assert.equal(a.error, null);
  assert.equal(b.error, "spawn bad ENOENT");
});

test("the environment of a Claude Code session is not passed on; programs are found on PATH", (t) => {
  assert.deepEqual(
    cleanEnv({
      claude_pid: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_CODE_USE_BEDROCK: "1",
      Path: "p",
    }),
    { CLAUDE_CODE_USE_BEDROCK: "1", Path: "p" },
  );
  const { root } = tempHome(t);
  write(join(root, "bin", "baton.CMD"), "@echo");
  write(join(root, "bin2", "claude"), "#!/bin/sh");
  assert.equal(
    which("baton", {
      env: {
        Path: `${join(root, "nope")};${join(root, "bin")}`,
        PATHEXT: ".EXE;.CMD",
      },
      platform: "win32",
    }),
    join(root, "bin", "baton.CMD"),
  );
  assert.equal(
    which("claude", { env: { PATH: join(root, "bin2") }, platform: "linux" }),
    join(root, "bin2", "claude"),
  );
  assert.equal(
    which("nothing", { env: { PATH: join(root, "bin2") }, platform: "linux" }),
    null,
  );
});

test("a link that cannot be followed still counts as a program, like Windows' wt.exe alias", (t) => {
  const { root } = tempHome(t);
  const bin = join(root, "aliases");
  mkdirSync(bin, { recursive: true });
  try {
    symlinkSync(join(root, "no-such-target"), join(bin, "wt"));
  } catch {
    // Windows without Developer Mode cannot create a file link.
    t.skip("file links are not allowed here");
    return;
  }
  assert.equal(
    which("wt", { env: { PATH: bin }, platform: "linux" }),
    join(bin, "wt"),
  );
});
