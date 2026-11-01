#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { pathsFor } from "./paths.js";

// osiris: one command for the operator and for the hooks. Commands live in
// one table: { group, usage, summary, options (node:util parseArgs options),
// run(ctx) }; run returns { data, screen, code }: data is printed for
// --json, screen(term) is the lines of spans drawn otherwise (screens.js,
// term.js). The hook path loads only what it needs, to stay fast.

export const commands = new Map();
const command = (name, definition) =>
  commands.set(name, { options: {}, ...definition });
export class UsageError extends Error {}
// A command that could not do its job, for a reason it can say plainly.
export class Failure extends Error {}

const GROUPS = {
  restore: "AFTER A SUDDEN RESTART",
  setup: "SETUP",
  more: "MORE",
};

const CLI_PATH = fileURLToPath(import.meta.url);

function readStdin(limit = 4 << 20) {
  if (process.stdin.isTTY) return "";
  try {
    const text = readFileSync(0, "utf8");
    return text.length > limit ? text.slice(0, limit) : text;
  } catch {
    return "";
  }
}

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const version = () =>
  parseJson(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
    ?.version ?? "0.0.0";

// A screen of screens.js, built when it is drawn (not for --json).
const screen =
  (name, ...args) =>
  async (term) =>
    (await import("./screens.js"))[name](term, ...args);

// ---- Claude Code's caller: the hooks --------------------------------------

command("record", {
  internal: true,
  usage: "osiris record <session-start|prompt|stop|stop-failure|session-end>",
  summary:
    "Record a Claude Code hook event (Claude Code runs this; reads the hook JSON on stdin).",
  async run({ positionals, env, paths }) {
    try {
      const { handleRecord } = await import("./record.js");
      handleRecord(positionals[0], parseJson(readStdin()), { env, paths });
    } catch {
      // A hook never fails the session.
    }
    return { code: 0, quiet: true };
  },
});

// ---- Bringing windows back ------------------------------------------------

const LAUNCH_OPTIONS = {
  yes: { type: "boolean", short: "y" },
  "dry-run": { type: "boolean" },
  keep: { type: "boolean" },
  print: { type: "boolean" },
  wt: { type: "boolean" },
  console: { type: "boolean" },
  tmux: { type: "boolean" },
  json: { type: "boolean" },
};

function launchMode(values) {
  const chosen = ["print", "wt", "console", "tmux"].filter((m) => values[m]);
  if (chosen.length > 1)
    throw new UsageError(
      `Choose one of --${chosen.join(", --")}, not several.`,
    );
  return chosen[0] ?? "auto";
}

// The shared end of `restore` and `scan`: choose, then open. `intro(term)`
// is what comes above the windows; `again` the command that reopens the
// ticked ones without asking.
async function bringBack(entries, ticks, ctx, { intro, empty, again }) {
  const { values, env, paths, stdout, stdin, now, home } = ctx;
  const launch = await import("./launch.js");
  const { withCommands } = await import("./restore.js");
  const { markHandled } = await import("./windows.js");
  const mode = launchMode(values);
  const found = {
    baton: launch.which("baton", { env }),
    claude: launch.which("claude", { env }),
    wt: process.platform === "win32" ? launch.which("wt", { env }) : null,
  };
  withCommands(entries, { baton: Boolean(found.baton) });
  if (!entries.length) return { data: { windows: [] }, screen: empty };

  const where = (item) =>
    launch.terminalFor(item.window, {
      mode,
      platform: process.platform,
      env,
      wt: found.wt,
    });
  const data = () => ({
    windows: entries.map((e, i) => ({
      session: e.window.session,
      ticked: Boolean(ticks[i]),
      via: e.command.via,
      cwd: e.command.cwd,
      title: e.command.title,
      lastSeen: e.window.lastSeen,
      beforeBoot: Boolean(e.window.beforeBoot),
      state: e.window.state ?? null,
      fresh: Boolean(e.fresh),
      problem: e.problem ?? null,
      opensIn: where(e),
      command: launch.commandLines(e.command),
      error: e.error ?? null,
    })),
  });
  const shared = { home, now, where, commandLines: launch.commandLines };

  let chosen;
  let picked = false;
  if (values["dry-run"] || values.yes || mode === "print" || values.json)
    chosen = entries.filter((_, i) => ticks[i]);
  else if (stdin.isTTY && stdout.isTTY) {
    const { terminalFor } = await import("./term.js");
    const screens = await import("./screens.js");
    const { pick } = await import("./pick.js");
    const term = terminalFor(stdout, env);
    const indexes = await pick({
      count: entries.length,
      checked: ticks,
      header: intro(term),
      block: (i, { ticked, current, width }) => [
        ...(i ? [[]] : []),
        ...screens.windowBlock(entries[i], {
          width,
          home,
          now,
          current,
          lead: screens.tickLead(term, ticked, current),
        }),
      ],
      footer: (state) => screens.pickFooter(term, state),
      term,
      input: stdin,
      output: stdout,
      mouse: env.OSIRIS_MOUSE !== "off",
    });
    if (!indexes) return { screen: screen("stoppedScreen") };
    chosen = indexes.map((i) => entries[i]);
    picked = true;
  } else
    return {
      data: data(),
      screen: async (term) =>
        (await import("./screens.js")).waitingScreen(term, {
          intro: intro(term),
          entries,
          ticks,
          home,
          now,
          again,
        }),
    };

  const ready = chosen.filter((e) => !e.problem);
  const skipped = chosen.filter((e) => e.problem);
  if (values["dry-run"])
    return {
      data: data(),
      screen: async (term) =>
        (await import("./screens.js")).dryRunScreen(term, {
          ...shared,
          intro: intro(term),
          ready,
          skipped,
          apply: again,
        }),
    };
  if (mode === "print")
    return {
      data: data(),
      screen: screen("printScreen", { ready, skipped, ...shared }),
    };
  if (values.json && !values.yes) return { data: data() };

  if (ready.some((e) => e.command.via === "claude") && !found.claude)
    throw new Failure(
      "claude is not on PATH, so nothing was reopened. `osiris restore --print` shows the commands.",
    );

  const plan = launch.planLaunch(ready, {
    paths,
    env,
    mode,
    wt: found.wt,
    now,
  });
  await launch.runLaunch(plan);

  // Windows only printed (no terminal to open them in here).
  const printed = plan.printed;
  const opened = ready.filter((e) => !printed.includes(e) && !e.error);
  const failed = ready.filter((e) => e.error);
  const records = (list) => list.filter((e) => e.window.file);
  markHandled(
    records(opened).map((e) => e.window),
    "restored",
    now,
  );
  if (picked)
    markHandled(
      records(entries.filter((e) => !chosen.includes(e))).map((e) => e.window),
      "dismissed",
      now,
    );
  return {
    code: failed.length ? 1 : 0,
    data: data(),
    screen: screen("resultScreen", {
      ...shared,
      opened,
      failed,
      skipped,
      printed,
    }),
    // Every window is back: the terminal this ran in has done its job
    // (close.js), unless --keep or something is left to read here.
    close:
      !values.keep &&
      opened.length > 0 &&
      !failed.length &&
      !skipped.length &&
      !printed.length &&
      Boolean(stdin.isTTY && stdout.isTTY),
  };
}

command("restore", {
  group: "restore",
  usage:
    "osiris [restore] [--all] [--yes] [--dry-run] [--keep] [--print|--wt|--console|--tmux] [--json]",
  summary:
    "List the Claude Code windows a sudden restart closed and reopen the ones you tick, each on its conversation.",
  options: { ...LAUNCH_OPTIONS, all: { type: "boolean" } },
  async run(ctx) {
    const { values, paths, env, now } = ctx;
    const { state, defaultTicks } = await import("./restore.js");
    const { readJson } = await import("./fsutil.js");
    const { lost, bootAt, groups } = state({
      paths,
      env,
      now,
      all: values.all,
    });
    const before = lost.filter((e) => e.window.beforeBoot).length;
    const screens = await import("./screens.js");
    return bringBack(lost, defaultTicks(lost), ctx, {
      intro: (term) =>
        screens.restoreIntro(term, {
          count: lost.length,
          before,
          bootAt,
          now,
        }),
      empty: screen("nothingToRestore", {
        installed: Boolean(readJson(paths.install)),
        live: groups.live.length,
      }),
      again: "osiris restore --yes",
    });
  },
});

command("scan", {
  group: "restore",
  usage:
    "osiris scan [--hours <n>] [--until boot|now|<time>] [--baton] [--yes] [--dry-run] [--keep] [--print|--wt|--console|--tmux] [--json]",
  summary:
    "Find conversations from their transcripts, for windows the hooks never saw, and reopen them.",
  options: {
    ...LAUNCH_OPTIONS,
    hours: { type: "string" },
    until: { type: "string" },
    baton: { type: "boolean" },
  },
  async run(ctx) {
    const { values, paths, env, now } = ctx;
    const { bootTime, state } = await import("./restore.js");
    const { projectRoots, scanTranscripts } = await import("./scan.js");
    const { listWindows } = await import("./windows.js");
    const hours = values.hours === undefined ? 3 : Number(values.hours);
    if (!Number.isFinite(hours) || hours <= 0)
      throw new UsageError("--hours takes a number of hours.");
    const until = values.until ?? "boot";
    const to =
      until === "boot"
        ? bootTime(env, now)
        : until === "now"
          ? now
          : Date.parse(until);
    if (!Number.isFinite(to))
      throw new UsageError("--until takes boot, now or a time.");
    const from = to - hours * 3600e3;
    // Conversations open in a window now are not offered.
    const { groups } = state({ paths, env, now });
    const skip = new Set(groups.live.map((w) => w.session));
    const roots = projectRoots(paths, listWindows(paths));
    const windows = scanTranscripts(roots, { from, to, skip });
    const entries = windows.map((window) => ({
      window: { ...window, viaBaton: Boolean(values.baton) },
      info: window.info,
    }));
    const screens = await import("./screens.js");
    return bringBack(
      entries,
      entries.map(() => true),
      ctx,
      {
        intro: (term) =>
          screens.scanIntro(term, {
            count: entries.length,
            from,
            to,
            now,
            roots,
            home: paths.home,
          }),
        empty: screen("nothingScanned", { from, to, now }),
        again: "osiris scan --yes",
      },
    );
  },
});

command("list", {
  group: "restore",
  usage: "osiris list [--all] [--json]",
  summary:
    "The windows Osiris knows: lost, open now, and with --all the ones closed earlier or already handled.",
  options: { all: { type: "boolean" }, json: { type: "boolean" } },
  async run(ctx) {
    const { values, paths, env, now, home } = ctx;
    const { entryOf, state } = await import("./restore.js");
    const { readJson } = await import("./fsutil.js");
    const { groups } = state({ paths, env, now });
    const items = (list) =>
      list.map((window) => entryOf(window, { bytes: 256 << 10 }));
    const sections = [
      { key: "lost", title: "LOST", items: items(groups.lost) },
      { key: "live", title: "OPEN", items: items(groups.live) },
      ...(values.all
        ? [
            { key: "closed", title: "CLOSED", items: items(groups.closed) },
            {
              key: "handled",
              title: "RESTORED OR DISMISSED",
              items: items(groups.handled),
            },
            {
              key: "superseded",
              title: "WENT ON ELSEWHERE",
              items: items(groups.superseded),
            },
          ]
        : []),
    ];
    const strip = ({ file, ...w }) => w;
    return {
      data: {
        lost: groups.lost.map(strip),
        live: groups.live.map(strip),
        ...(values.all
          ? {
              closed: groups.closed.map(strip),
              handled: groups.handled.map(strip),
              superseded: groups.superseded.map(strip),
            }
          : {}),
      },
      screen: screen("listScreen", {
        sections,
        home,
        now,
        installed: Boolean(readJson(paths.install)),
      }),
    };
  },
});

// ---- Setup ----------------------------------------------------------------

// Baton's profiles, with whether each one's settings.json has the hooks.
async function batonProfiles(paths) {
  const { existsSync, readdirSync } = await import("node:fs");
  const { hookState } = await import("./install.js");
  if (!existsSync(paths.batonAccounts)) return [];
  const out = [];
  for (const id of readdirSync(paths.batonAccounts)) {
    const file = join(paths.batonAccounts, id, "settings.json");
    if (!existsSync(file)) continue;
    const state = hookState(file);
    out.push({
      id,
      ok: state.ok && Object.values(state.events).every((e) => e.installed),
    });
  }
  return out;
}

async function setup(mode, ctx) {
  const { values, paths, now, home } = ctx;
  const install = await import("./install.js");
  const { EVENTS } = await import("./record.js");
  let plan;
  try {
    plan =
      mode === "install"
        ? install.planInstall({ paths, cliPath: realpathSync(CLI_PATH) })
        : install.planUninstall({ paths });
  } catch (error) {
    if (error instanceof install.InstallError) throw new Failure(error.message);
    throw error;
  }
  const dryRun = Boolean(values["dry-run"]);
  const applied = dryRun
    ? { changed: false, backup: null }
    : install.applyPlan(plan, { paths, now });
  const profiles = mode === "install" ? await batonProfiles(paths) : [];
  return {
    data: {
      action: dryRun || applied.changed ? plan.action : "same",
      dryRun,
      backup: applied.backup,
      files: plan.files.map((f) => ({ path: f.path, diff: f.diff })),
      profiles,
    },
    screen: screen("planScreen", {
      mode,
      plan,
      events: Object.values(EVENTS),
      dryRun,
      applied,
      diff: Boolean(values.diff),
      home,
      profiles,
    }),
  };
}

command("install", {
  group: "setup",
  usage: "osiris install [--dry-run] [--diff] [--json]",
  summary:
    "Add Osiris's hooks to ~/.claude/settings.json (Baton's profiles get them from there).",
  options: {
    "dry-run": { type: "boolean" },
    diff: { type: "boolean" },
    json: { type: "boolean" },
  },
  run: (ctx) => setup("install", ctx),
});

command("uninstall", {
  group: "setup",
  usage: "osiris uninstall [--dry-run] [--diff] [--json]",
  summary: "Remove exactly Osiris's hooks from ~/.claude/settings.json.",
  options: {
    "dry-run": { type: "boolean" },
    diff: { type: "boolean" },
    json: { type: "boolean" },
  },
  run: (ctx) => setup("uninstall", ctx),
});

command("doctor", {
  group: "setup",
  usage: "osiris doctor [--json]",
  summary: "Check the hooks, Baton's profiles and the programs a restore runs.",
  options: { json: { type: "boolean" } },
  async run(ctx) {
    const { paths, env, now, home } = ctx;
    const { hookState, settingsPath } = await import("./install.js");
    const { which } = await import("./launch.js");
    const { state } = await import("./restore.js");
    const { tildify, plural } = await import("./text.js");
    const settingsFile = settingsPath(paths);
    const hooks = hookState(settingsFile);
    const describe = (s) => {
      if (!s.ok) return { ok: false, text: s.error };
      const events = Object.entries(s.events);
      const missing = events.filter(([, e]) => !e.installed).map(([n]) => n);
      if (missing.length === events.length)
        return { ok: false, text: "no hooks" };
      if (missing.length)
        return { ok: false, text: `missing ${missing.join(", ")}` };
      if (events.some(([, e]) => !e.cliExists || !e.nodeExists))
        return {
          ok: false,
          text: "the hooks point at a node or cli.js that is gone",
        };
      return { ok: true, text: `all ${events.length} hooks` };
    };
    const main = describe(hooks);
    const profiles = await batonProfiles(paths);
    const programs = {
      claude: which("claude", { env }),
      baton: which("baton", { env }),
      ...(process.platform === "win32" ? { wt: which("wt", { env }) } : {}),
    };
    const { groups } = state({ paths, env, now });
    const sections = [
      {
        title: "Hooks",
        checks: [
          {
            name: "settings.json",
            state: main.ok ? "ok" : "fail",
            detail: `${tildify(settingsFile, home)}: ${main.ok ? main.text : `${main.text}, run osiris install`}`,
          },
        ],
      },
      {
        title: "Baton profiles",
        checks: profiles.map((p) => ({
          name: p.id,
          state: p.ok ? "ok" : "warn",
          detail: p.ok
            ? "has the hooks"
            : "no hooks yet: Baton copies settings.json into it at its next launch",
        })),
      },
      {
        title: "Programs",
        checks: [
          {
            name: "claude",
            state: programs.claude ? "ok" : "fail",
            detail: programs.claude ?? "not on PATH: nothing can be reopened",
          },
          {
            name: "baton",
            state: programs.baton ? "ok" : "info",
            detail:
              programs.baton ??
              "not on PATH: Baton's windows resume in plain claude",
          },
          ...("wt" in programs
            ? [
                {
                  name: "wt",
                  state: programs.wt ? "ok" : "info",
                  detail:
                    programs.wt ??
                    "not on PATH: Windows Terminal's windows come back as console windows",
                },
              ]
            : []),
        ],
      },
      {
        title: "Windows",
        checks: [
          {
            name: "recorded",
            state: "info",
            detail: `${groups.live.length} open · ${plural(groups.lost.length, "lost", "lost")} · ${groups.closed.length} closed`,
          },
        ],
      },
    ];
    const problems = sections
      .flatMap((x) => x.checks)
      .filter((c) => c.state === "fail")
      .map((c) => `${c.name}: ${c.detail}`);
    return {
      code: problems.length ? 1 : 0,
      data: {
        ok: !problems.length,
        problems,
        settings: main,
        profiles,
        programs,
        windows: {
          live: groups.live.length,
          lost: groups.lost.length,
          closed: groups.closed.length,
        },
      },
      screen: screen("doctorScreen", { sections }),
    };
  },
});

command("help", {
  group: "more",
  usage: "osiris help [command]",
  summary: "Show the commands, or one command's usage.",
  async run({ positionals }) {
    const name = positionals[0];
    if (name) {
      const c = commands.get(name);
      if (!c || c.internal) throw new UsageError(`No command "${name}".`);
      return { screen: screen("usageScreen", c) };
    }
    return {
      screen: screen("helpScreen", {
        groups: GROUPS,
        commands,
        version: version(),
      }),
    };
  },
});

// ---- Entry ----------------------------------------------------------------

async function present(result, { json, stdout, env }) {
  if (json && result.data !== undefined) {
    stdout.write(JSON.stringify(result.data, null, 2) + "\n");
    return;
  }
  if (!result.screen) return;
  const { terminalFor, render, document } = await import("./term.js");
  const term = terminalFor(stdout, env);
  stdout.write(render(document(await result.screen(term), term), term) + "\n");
}

// An error for stderr, in the screens' look when stderr is a terminal, with
// the command's usage.
async function complain(message, usage, { stderr, env }) {
  const { terminalFor, errorText } = await import("./term.js");
  stderr.write(errorText(message, terminalFor(stderr, env), usage) + "\n");
}

export async function main(
  argv = process.argv.slice(2),
  {
    env = process.env,
    stdout = process.stdout,
    stderr = process.stderr,
    stdin = process.stdin,
    now = Date.now(),
  } = {},
) {
  if (argv[0] === "--version" || argv[0] === "-v") {
    stdout.write(version() + "\n");
    return 0;
  }
  if (argv[0] === "--help" || argv[0] === "-h")
    argv = ["help", ...argv.slice(1)];
  const name = argv[0] && !argv[0].startsWith("-") ? argv[0] : "restore";
  const rest = name === argv[0] ? argv.slice(1) : argv;
  const definition = commands.get(name);
  if (!definition) {
    await complain(`No command "${name}". Try osiris help.`, null, {
      stderr,
      env,
    });
    return 2;
  }
  const paths = pathsFor(env);
  let parsed;
  try {
    try {
      parsed = parseArgs({
        args: rest,
        options: {
          ...definition.options,
          help: { type: "boolean", short: "h" },
        },
        allowPositionals: true,
        strict: true,
      });
    } catch (error) {
      throw new UsageError(error.message);
    }
    if (parsed.values.help) {
      await present(
        { screen: screen("usageScreen", definition) },
        { json: false, stdout, env },
      );
      return 0;
    }
    const result = await definition.run({
      values: parsed.values,
      positionals: parsed.positionals,
      env,
      paths,
      stdout,
      stdin,
      now,
      home: paths.home,
    });
    if (!result.quiet)
      await present(result, { json: parsed.values.json, stdout, env });
    if (result.close) (await import("./close.js")).closeTerminal();
    return result.code ?? 0;
  } catch (error) {
    if (error instanceof UsageError) {
      await complain(error.message, definition.usage, { stderr, env });
      return 2;
    }
    if (error instanceof Failure) {
      await complain(error.message, null, { stderr, env });
      return 1;
    }
    await complain(error.stack ?? error.message, null, { stderr, env });
    return 1;
  }
}

const invoked = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(CLI_PATH);
  } catch {
    return false;
  }
})();
if (invoked) process.exitCode = await main();
