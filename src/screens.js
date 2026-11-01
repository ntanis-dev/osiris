import { joinFacts, lineWidth, s, spread, wrapLine } from "./lines.js";
import {
  banner,
  entry,
  fact,
  heading,
  hints,
  marks,
  next,
  outcome,
  paragraph,
  room,
} from "./term.js";
import { FRESH_TITLE } from "./launch.js";
import { plural, tildify, when } from "./text.js";

// What the commands print, as lines of spans (term.js draws them). Every
// screen is built from the same pieces, so they all read alike.

// ---- Windows ----------------------------------------------------------------

const VIA_STYLE = { baton: "info", claude: "info" };

// Where a window goes back to, in words.
export const WHERE = {
  console: "a console window",
  wt: "a Windows Terminal tab",
  tmux: "a tmux window",
  print: "commands to run by hand",
};

// One window: its mark and title, then its folder, how it resumes, when it
// was last seen and what to know about it. `lead` is the mark; `extra` more
// facts (each a list of spans).
export function windowBlock(
  item,
  { width, home, now, lead, current = false, extra = [] },
) {
  const { window, command, info } = item;
  const title =
    command?.title ??
    info?.title ??
    (item.fresh ? FRESH_TITLE : window.session);
  const via =
    command?.via ?? (window.wrapper || window.viaBaton ? "baton" : "claude");
  const folder = tildify(command?.cwd ?? window.cwd ?? info?.cwd ?? "?", home);
  const indent = lineWidth(lead) + 1;
  const head = wrapLine(
    [...lead, s(" "), s(title, current ? "accent bold" : "bold")],
    width,
    indent,
  );
  const facts = joinFacts([
    [s(folder)],
    [s(via, VIA_STYLE[via])],
    [s(when(Date.parse(window.lastSeen), now), "muted")],
    window.state === "running" ? [s("was working", "warn")] : null,
    item.problem ? [s(item.problem, "err")] : null,
    ...extra,
  ]);
  return [
    ...head,
    ...wrapLine([s(" ".repeat(indent)), ...facts], width, indent),
  ];
}

// Window blocks with a blank line between them.
export const spaced = (blocks) =>
  blocks.flatMap((block, i) => (i ? [[], ...block] : block));

// The tick in front of a window in a list to choose from; with a cursor
// column in the picker.
export function tickLead(term, ticked, cursor = null) {
  const g = term.g;
  return [
    ...(cursor === null
      ? []
      : [s(cursor ? g.cursor : " ", "accent bold"), s(" ")]),
    s(ticked ? g.tick : g.untick, ticked ? "ok bold" : "muted"),
  ];
}

// ---- Restore and scan -------------------------------------------------------

// What comes above the windows to restore.
export function restoreIntro(term, { count, before, bootAt, now }) {
  const width = room(term);
  const lines = [
    ...banner(term),
    heading(
      "RESTORE",
      width,
      term,
      before ? `computer restarted ${when(bootAt, now)}` : "",
    ),
    [],
  ];
  if (before) {
    lines.push(
      ...wrapLine(
        [
          s(
            `${plural(before, "Claude Code window")} ${before === 1 ? "was" : "were"} open when the computer stopped.`,
          ),
        ],
        width,
      ),
    );
    if (count > before)
      lines.push(
        ...paragraph(
          `${plural(count - before, "more window")} closed without exiting since: listed, not ticked.`,
          width,
        ),
      );
  } else
    lines.push(
      ...paragraph(
        "Claude Code windows that closed without exiting.",
        width,
        "",
      ),
    );
  lines.push([]);
  return lines;
}

export function scanIntro(term, { count, from, to, now, roots, home }) {
  const width = room(term);
  return [
    ...banner(term),
    heading("SCAN", width, term, `${when(from, now)} to ${when(to, now)}`),
    [],
    ...wrapLine(
      [
        s(`${plural(count, "conversation")} written to in that span`),
        s(
          ` (${roots.map((r) => tildify(r.dir, home)).join(", ")}). A transcript does not say whether its window was still open: check the list.`,
          "muted",
        ),
      ],
      width,
    ),
    [],
  ];
}

// The picker's footer: what is ticked, where the list is, and the keys (a
// click on one does what it says).
export function pickFooter(term, { ticked, count, first, last }) {
  const g = term.g;
  return [
    s(`${ticked} of ${count} ticked`, ticked ? "bold" : "muted"),
    ...(first > 0 || last < count
      ? [s(` · ${first + 1}-${last} of ${count}`, "muted")]
      : []),
    s("   "),
    ...hints([
      [`${g.up}${g.down}`, "move"],
      ["space", "tick", "toggle"],
      ["a", "all", "all"],
      [g.enter, "reopen", "enter"],
      ["q", "quit", "cancel"],
    ]),
  ];
}

// No terminal to choose in: the list as it would be ticked, and how to go
// on.
export function waitingScreen(
  term,
  { intro, entries, ticks, home, now, again },
) {
  const width = room(term);
  return [
    ...intro,
    ...spaced(
      entries.map((item, i) =>
        windowBlock(item, {
          width,
          home,
          now,
          lead: tickLead(term, ticks[i]),
        }),
      ),
    ),
    [],
    ...fact(
      "Reopen",
      [
        s(again, "accent bold"),
        s(
          " reopens the ticked ones; run in a terminal, Osiris lets you choose.",
          "muted",
        ),
      ],
      width,
    ),
  ];
}

export function dryRunScreen(
  term,
  { intro, ready, skipped, where, commandLines, home, now, apply },
) {
  const width = room(term);
  const m = marks(term.g);
  const lines = [...intro];
  for (const item of ready) {
    lines.push(
      ...windowBlock(item, {
        width,
        home,
        now,
        lead: m.next,
        extra: [[s(`opens in ${WHERE[where(item)]}`, "muted")]],
      }),
    );
    for (const line of commandLines(item.command))
      lines.push(...wrapLine([s("    " + line, "accent")], width, 6));
    lines.push([]);
  }
  for (const item of skipped)
    lines.push(...windowBlock(item, { width, home, now, lead: m.skip }), []);
  lines.push(
    outcome(term, "Dry run: nothing was opened.", "info"),
    [],
    ...fact("Apply", [s(apply, "accent bold")], width),
  );
  return lines;
}

// --print: the commands, ready to run (plain when piped, so they copy as
// they are).
export function printScreen(term, { ready, skipped, commandLines }) {
  const lines = [...banner(term)];
  for (const item of ready) {
    lines.push([s(`# ${item.command.title}`, "muted")]);
    for (const line of commandLines(item.command))
      lines.push([s(line, "accent")]);
    lines.push([]);
  }
  for (const item of skipped)
    lines.push([
      s(`# skipped: ${item.command.title} (${item.problem})`, "warn"),
    ]);
  while (lines.length && !lines.at(-1).length) lines.pop();
  return lines;
}

export function resultScreen(
  term,
  { opened, failed, skipped, printed, where, commandLines, home, now },
) {
  const width = room(term);
  const m = marks(term.g);
  const lines = [...banner(term)];
  if (opened.length)
    lines.push(
      outcome(term, `Reopened ${plural(opened.length, "window")}.`),
      [],
    );
  else if (!failed.length && !printed.length)
    lines.push(outcome(term, "Nothing reopened.", "skip"), []);
  else if (failed.length)
    lines.push(outcome(term, "Nothing reopened.", "fail"), []);
  lines.push(
    ...spaced([
      ...opened.map((item) =>
        windowBlock(item, {
          width,
          home,
          now,
          lead: m.done,
          extra: [[s(`in ${WHERE[where(item)]}`, "muted")]],
        }),
      ),
      ...failed.map((item) =>
        windowBlock(item, {
          width,
          home,
          now,
          lead: m.fail,
          extra: [[s(`could not open: ${item.error}`, "err")]],
        }),
      ),
      ...skipped.map((item) =>
        windowBlock(item, { width, home, now, lead: m.skip }),
      ),
    ]),
  );
  if (printed.length) {
    lines.push(
      [],
      heading("RUN BY HAND", width, term, "no terminal to open them in here"),
      [],
    );
    for (const item of printed) {
      lines.push([s(`# ${item.command.title}`, "muted")]);
      for (const line of commandLines(item.command))
        lines.push([s(line, "accent")]);
      lines.push([]);
    }
    while (lines.length && !lines.at(-1).length) lines.pop();
  }
  return lines;
}

export const stoppedScreen = (term) => [
  ...banner(term),
  outcome(term, "Nothing reopened.", "skip"),
];

export function nothingToRestore(term, { installed, live }) {
  const width = room(term);
  const lines = [
    ...banner(term),
    outcome(term, "Nothing to restore.", "same"),
    [],
  ];
  if (installed)
    lines.push(
      ...paragraph(
        `Every window Osiris saw is open now (${live}), was exited at its prompt, or was closed before the last ones (osiris list --all shows them).`,
        width,
      ),
    );
  else
    lines.push(
      ...paragraph(
        "Osiris's hooks are not installed, so it has not seen a window yet.",
        width,
        "warn",
      ),
      [],
      ...next("osiris install", width),
      ...fact(
        "Before",
        [
          s("osiris scan", "accent bold"),
          s(" finds conversations from their transcripts", "muted"),
        ],
        width,
      ),
    );
  return lines;
}

export function nothingScanned(term, { from, to, now }) {
  const width = room(term);
  return [
    ...banner(term),
    outcome(
      term,
      `No conversation was written to between ${when(from, now)} and ${when(to, now)}.`,
      "same",
    ),
    [],
    ...fact(
      "Try",
      [
        s("osiris scan --hours 12", "accent bold"),
        s(" or ", "muted"),
        s("--until now", "accent bold"),
      ],
      width,
    ),
  ];
}

// ---- list -------------------------------------------------------------------

export function listScreen(term, { sections, home, now, installed }) {
  const width = room(term);
  const g = term.g;
  const lines = [...banner(term)];
  const shown = sections.filter((section) => section.items.length);
  if (!shown.length) {
    lines.push(outcome(term, "No windows recorded yet.", "same"), []);
    if (!installed) lines.push(...next("osiris install", width));
    else
      lines.push(
        ...paragraph(
          "Claude Code windows are recorded from their next start.",
          width,
        ),
      );
    return lines;
  }
  const MARK = {
    lost: [s(g.dot, "warn bold")],
    live: [s(g.dot, "ok bold")],
    closed: [s(g.check, "muted")],
    handled: [s(g.ring, "muted")],
    superseded: [s(g.ring, "muted")],
  };
  shown.forEach((section, i) => {
    if (i) lines.push([]);
    lines.push(
      heading(
        section.title,
        width,
        term,
        section.note ?? String(section.items.length),
      ),
      [],
    );
    lines.push(
      ...spaced(
        section.items.map((item) =>
          windowBlock(item, { width, home, now, lead: MARK[section.key] }),
        ),
      ),
    );
  });
  if (sections.find((x) => x.key === "lost")?.items.length)
    lines.push(
      [],
      ...fact(
        "Next",
        [s("osiris", "accent bold"), s(" reopens the lost ones", "muted")],
        width,
      ),
    );
  return lines;
}

// ---- install and uninstall --------------------------------------------------

const WORDS = {
  add: ["added", "will add"],
  update: ["updated", "will update"],
  remove: ["removed", "will remove"],
  same: ["in place", "in place"],
  absent: ["not installed", "not installed"],
};

function countDiff(diff) {
  let added = 0;
  let removed = 0;
  for (const line of diff)
    if (line.startsWith("+ ")) added++;
    else if (line.startsWith("- ")) removed++;
  return { added, removed };
}

// The plan and what came of it. `diff` shows every changed line; `profiles`
// are Baton's, with whether each has the hooks yet.
export function planScreen(
  term,
  { mode, plan, events, dryRun, applied, diff, home, profiles = [] },
) {
  const width = room(term);
  const g = term.g;
  const m = marks(g);
  const lines = [
    ...banner(term, { full: mode === "install" }),
    heading(mode.toUpperCase(), width, term, dryRun ? "dry run" : ""),
    [],
  ];
  const changing = ["add", "update", "remove"].includes(plan.action);
  const mark = !changing
    ? plan.action === "same"
      ? m.same
      : m.skip
    : dryRun
      ? m.next
      : m.done;
  const word = WORDS[plan.action][dryRun ? 1 : 0];
  lines.push(
    ...wrapLine(
      [
        ...mark,
        s(" "),
        s("Hooks".padEnd(10), "bold"),
        s(
          word.padEnd(14),
          changing ? (dryRun ? "accent bold" : "ok bold") : "muted",
        ),
        s(events.join(` ${g.sep} `), "muted"),
      ],
      width,
      26,
    ),
  );
  if (plan.files.length) {
    lines.push([], heading("FILES", width, term), []);
    for (const f of plan.files) {
      const { added, removed } = countDiff(f.diff);
      const what =
        f.after === null ? "remove" : f.before === null ? "create" : "change";
      lines.push(
        spread(
          [s(what.padEnd(8), "muted"), s(tildify(f.path, home))],
          [
            ...(added ? [s(`+${added}`, "ok bold")] : []),
            ...(added && removed ? [s(" ")] : []),
            ...(removed ? [s(`${g.less}${removed}`, "err bold")] : []),
          ],
          width,
        ),
      );
      if (diff)
        for (const line of f.diff)
          lines.push(
            ...wrapLine(
              [
                s(
                  "    " + line,
                  line[0] === "+" ? "ok" : line[0] === "-" ? "err" : "muted",
                ),
              ],
              width,
              6,
            ),
          );
    }
    if (!diff)
      lines.push(
        [],
        [
          s("Add ", "muted"),
          s("--diff", "accent"),
          s(" to see every changed line.", "muted"),
        ],
      );
  }
  lines.push([]);
  if (dryRun) {
    lines.push(
      outcome(term, "Dry run: nothing was written.", "info"),
      [],
      ...fact("Apply", [s(`osiris ${mode}`, "accent bold")], width),
    );
    return lines;
  }
  if (!applied.changed) {
    lines.push(
      outcome(
        term,
        mode === "install"
          ? "Already installed. Nothing to change."
          : "Not installed. Nothing to change.",
        mode === "install" ? "same" : "skip",
      ),
    );
    if (mode === "install") lines.push(...profileLines(term, profiles, width));
    return lines;
  }
  lines.push(
    outcome(term, mode === "install" ? "Installed" : "Uninstalled"),
    [],
  );
  if (applied.backup)
    lines.push(...fact("Backup", [s(tildify(applied.backup, home))], width));
  if (mode === "uninstall") {
    lines.push(...fact("Again", [s("osiris install")], width));
    return lines;
  }
  lines.push(...fact("Undo", [s("osiris uninstall")], width));
  lines.push(...profileLines(term, profiles, width));
  lines.push(
    [],
    ...paragraph(
      "Claude Code reads hooks when it starts: windows open now are recorded once they restart. For conversations from before, osiris scan is the fallback.",
      width,
    ),
    [],
    ...next("osiris doctor", width),
  );
  return lines;
}

function profileLines(term, profiles, width) {
  if (!profiles.length) return [];
  const m = marks(term.g);
  const nameWidth = Math.max(...profiles.map((p) => p.id.length));
  return [
    [],
    heading("BATON PROFILES", width, term),
    [],
    ...profiles.flatMap((p) =>
      entry(
        p.ok ? m.ok : m.skip,
        p.id,
        [
          s(
            p.ok ? "has the hooks" : "gets them at Baton's next launch",
            "muted",
          ),
        ],
        width,
        nameWidth,
      ),
    ),
  ];
}

// ---- doctor -----------------------------------------------------------------

// sections: [{ title, checks: [{ name, state: ok|fail|warn|info, detail }] }]
export function doctorScreen(term, { sections }) {
  const width = room(term);
  const m = marks(term.g);
  const all = sections.flatMap((x) => x.checks);
  const nameWidth = Math.min(24, Math.max(...all.map((c) => c.name.length)));
  const failed = all.filter((c) => c.state === "fail").length;
  const warned = all.filter((c) => c.state === "warn").length;
  const lines = [...banner(term), heading("DOCTOR", width, term), []];
  sections.forEach((section, i) => {
    if (!section.checks.length) return;
    if (i) lines.push([]);
    lines.push([s(section.title, "muted bold")]);
    for (const c of section.checks)
      lines.push(
        ...entry(
          m[c.state],
          c.name,
          [s(c.detail, c.state === "fail" ? "" : "muted")],
          width,
          nameWidth,
        ),
      );
  });
  lines.push(
    [],
    failed
      ? outcome(term, `${plural(failed, "check")} failed.`, "fail")
      : warned
        ? outcome(
            term,
            `All checks passed; ${plural(warned, "note")} above.`,
            "done",
          )
        : outcome(term, "All checks passed."),
  );
  return lines;
}

// ---- help -------------------------------------------------------------------

export function helpScreen(term, { groups, commands, version }) {
  const width = room(term);
  const names = [...commands.entries()].filter(([, c]) => !c.internal);
  const nameWidth = Math.max(...names.map(([n]) => n.length)) + 3;
  const lines = [
    ...banner(term, { full: true }),
    ...wrapLine(
      [
        s("osiris", "accent bold"),
        s(
          ` on its own lists the windows a sudden restart closed and reopens the ones you tick. Version ${version}.`,
          "muted",
        ),
      ],
      width,
    ),
  ];
  for (const [group, title] of Object.entries(groups)) {
    lines.push([], heading(title, width, term), []);
    for (const [n, c] of names)
      if (c.group === group)
        lines.push(
          ...wrapLine(
            [s(n.padEnd(nameWidth), "accent bold"), s(c.summary)],
            width,
            nameWidth,
          ),
        );
  }
  lines.push(
    [],
    [
      s("osiris help <command>", "accent"),
      s(" shows a command's options.", "muted"),
    ],
  );
  return lines;
}

export function usageScreen(term, c) {
  const width = room(term);
  return [
    ...banner(term),
    heading("USAGE", width, term),
    [],
    ...wrapLine([s(c.usage, "accent")], width, 4),
    [],
    ...paragraph(c.summary, width, ""),
  ];
}
