import { test } from "node:test";
import assert from "node:assert/strict";
import { pickGlyphs } from "../src/look.js";
import { s, wrapLine, lineWidth } from "../src/lines.js";
import {
  planScreen,
  doctorScreen,
  printScreen,
  stoppedScreen,
  windowBlock,
} from "../src/screens.js";
import {
  document,
  errorText,
  makeTerminal,
  render,
  terminalFor,
} from "../src/term.js";
import { tildify, when } from "../src/text.js";

const plan = {
  action: "add",
  files: [
    {
      path: "/home/me/.claude/settings.json",
      before: "{}",
      after: "{}",
      diff: ["+ a", "+ b", "- c"],
    },
  ],
};
const events = ["SessionStart", "SessionEnd"];
const show = (term, lines) => render(document(lines, term), term);

test("a terminal gets the banner, colour and glyphs; a pipe gets plain text", () => {
  const tty = makeTerminal({ tty: true, depth: 24, glyphs: "rich" });
  const styled = show(
    tty,
    planScreen(tty, {
      mode: "install",
      plan,
      events,
      dryRun: true,
      applied: { changed: false },
      home: "/home/me",
    }),
  );
  assert.match(styled, /\x1b\[1;38;2;242;196;109m {3}____/);
  assert.match(styled, /Every Claude Code window back after a sudden restart/);
  assert.match(styled, /›/);
  assert.match(styled, /\+2/);

  const pipe = makeTerminal({ tty: false, styled: false, glyphs: "plain" });
  const plain = show(
    pipe,
    planScreen(pipe, {
      mode: "install",
      plan,
      events,
      dryRun: true,
      applied: { changed: false },
      home: "/home/me",
    }),
  );
  assert.doesNotMatch(plain, /\x1b/);
  assert.doesNotMatch(plain, /____/);
  assert.match(plain, /^ {2}INSTALL {2}─+ {2}dry run$/m);
  assert.match(plain, /^ {2}> Hooks +will add +SessionStart · SessionEnd$/m);
  assert.match(plain, /change +~\/\.claude\/settings\.json +\+2 -1/);
});

test("NO_COLOR keeps bold and drops colour; FORCE_COLOR styles a pipe", () => {
  const stream = { isTTY: true, columns: 80, getColorDepth: () => 24 };
  const noColor = terminalFor(stream, { NO_COLOR: "1" });
  const text = render([[s("done", "ok bold")]], noColor);
  assert.equal(text, "\x1b[1mdone\x1b[0m");
  const forced = terminalFor({ isTTY: false }, { FORCE_COLOR: "1" });
  assert.equal(forced.tty, false);
  assert.match(render([[s("x", "err")]], forced), /\x1b\[38;5;\d+mx/);
  assert.equal(
    render([[s("x", "err")]], terminalFor({ isTTY: false }, {})),
    "x",
  );
});

test("the classic Windows console gets the plain glyphs", () => {
  assert.equal(pickGlyphs({}, "win32"), "plain");
  assert.equal(pickGlyphs({ WT_SESSION: "x" }, "win32"), "rich");
  assert.equal(pickGlyphs({ TERM_PROGRAM: "vscode" }, "win32"), "rich");
  assert.equal(pickGlyphs({}, "linux"), "rich");
  assert.equal(pickGlyphs({ OSIRIS_GLYPHS: "plain" }, "darwin"), "plain");
});

test("long lines wrap under themselves and nothing is cut", () => {
  const lines = wrapLine(
    [s("Next      "), s("a fairly long next step that does not fit")],
    24,
    10,
  );
  assert.ok(lines.length > 1);
  for (const line of lines) assert.ok(lineWidth(line) <= 24);
  assert.equal(
    lines
      .map((l) =>
        l
          .map(([t]) => t)
          .join("")
          .trim(),
      )
      .join(" ")
      .replace(/ +/g, " "),
    "Next a fairly long next step that does not fit",
  );
  // The value's continuation lines start under it, at the label column.
  assert.ok(lines.slice(1).every((l) => l[0][0] === " ".repeat(10)));
});

test("a window reads as its title, then its folder, launcher, time and notes", () => {
  const term = makeTerminal({ tty: false, styled: false, glyphs: "plain" });
  const now = Date.parse("2026-10-31T12:00:00");
  const lines = windowBlock(
    {
      window: {
        session: "s",
        cwd: "/home/me/work/app",
        lastSeen: new Date(now - 60e3).toISOString(),
        wrapper: "1-ab",
        state: "running",
      },
      info: { title: "Payments refactor" },
      problem: null,
    },
    { width: 80, home: "/home/me", now, lead: [s("[x]")] },
  );
  assert.deepEqual(render(lines, term).split("\n"), [
    "[x] Payments refactor",
    "    ~/work/app · baton · 11:59 · was working",
  ]);
});

test("doctor counts failures, and an error says what went wrong", () => {
  const term = makeTerminal({ tty: false, styled: false, glyphs: "plain" });
  const text = render(
    doctorScreen(term, {
      sections: [
        {
          title: "Programs",
          checks: [
            { name: "claude", state: "fail", detail: "not on PATH" },
            { name: "wt", state: "info", detail: "not on PATH" },
          ],
        },
      ],
    }),
    term,
  );
  assert.match(text, /^x claude +not on PATH$/m);
  assert.match(text, /^x 1 check failed\.$/m);
  assert.equal(errorText("boom", term), "osiris: boom");
  assert.equal(tildify("C:\\Users\\me\\x", "C:\\Users\\me"), "~/x");
  assert.equal(
    when(Date.parse("2026-10-30T12:00:00"), Date.parse("2026-10-31T12:00:00")),
    "Fri 12:00",
  );
});

test("the screens a command ends on carry the mark on a terminal, and errors too", () => {
  const tty = makeTerminal({ tty: true, styled: false, glyphs: "plain" });
  const pipe = makeTerminal({ tty: false, styled: false, glyphs: "plain" });
  assert.match(show(tty, stoppedScreen(tty)), /OSIRIS[^]*Nothing reopened/);
  const printed = {
    ready: [{ command: { title: "Fix it" } }],
    skipped: [],
    commandLines: () => ["claude --resume x"],
  };
  assert.match(show(tty, printScreen(tty, printed)), /OSIRIS[^]*# Fix it/);
  // Piped, the commands are all there is.
  assert.equal(
    show(pipe, printScreen(pipe, printed)),
    "  # Fix it\n  claude --resume x",
  );
  const error = errorText("No command.", tty, "osiris list [--all]");
  assert.match(error, /OSIRIS[^]*No command\.[^]*Usage +osiris list/);
  assert.equal(
    errorText("No command.", pipe, "osiris list [--all]"),
    "osiris: No command.\nosiris list [--all]",
  );
});
