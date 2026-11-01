import { lineWidth, s, wrapLine } from "./lines.js";
import { branding, glyphSets, pickGlyphs, styleProps } from "./look.js";

// What the commands print is built as lines of [text, style] spans in the
// palette and glyphs of look.js, measured in terminal cells and wrapped to
// the terminal (Baton's and Pelican's principles). This file turns them into
// ANSI text for a terminal, or into plain text when the output is not one (a
// pipe, a test, a script): NO_COLOR keeps the layout and drops the colour,
// FORCE_COLOR styles a pipe anyway.

const BASIC = [
  [0, 0, 0],
  [205, 49, 49],
  [13, 188, 121],
  [229, 229, 16],
  [36, 114, 200],
  [188, 63, 188],
  [17, 168, 205],
  [229, 229, 229],
  [102, 102, 102],
  [241, 76, 76],
  [35, 209, 139],
  [245, 245, 67],
  [59, 142, 234],
  [214, 112, 214],
  [41, 184, 219],
  [255, 255, 255],
];

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

// A colour at the depth the terminal has: 24-bit, 256 colours, or the
// nearest of the 16 basic ones.
function colorCodes(color, depth) {
  const [r, g, b] = rgb(color);
  if (depth >= 24) return [38, 2, r, g, b];
  if (depth >= 8) {
    const level = (v) => Math.round((v / 255) * 5);
    return [38, 5, 16 + 36 * level(r) + 6 * level(g) + level(b)];
  }
  let best = 0;
  let distance = Infinity;
  BASIC.forEach(([cr, cg, cb], i) => {
    const d = (cr - r) ** 2 + (cg - g) ** 2 + (cb - b) ** 2;
    if (d < distance) [best, distance] = [i, d];
  });
  return [best < 8 ? 30 + best : 82 + best];
}

const CODES = { bold: 1, dim: 2, italic: 3, underline: 4, inverse: 7 };

function escape(props, depth) {
  const codes = [];
  for (const [name, code] of Object.entries(CODES))
    if (props[name]) codes.push(code);
  if (props.color) codes.push(...colorCodes(props.color, depth));
  return codes.length ? `\x1b[${codes.join(";")}m` : "";
}

// The terminal a command writes to: whether it styles, its colour depth, its
// glyphs and the width to lay out in (kept readable on a wide one).
export function terminalFor(stream, env = process.env) {
  const tty = Boolean(stream?.isTTY);
  const forced = env.FORCE_COLOR && env.FORCE_COLOR !== "0";
  let depth = 1;
  if (env.NO_COLOR || env.TERM === "dumb") depth = 1;
  else if (tty && typeof stream.getColorDepth === "function")
    depth = stream.getColorDepth(env);
  else if (forced) depth = 8;
  return makeTerminal({
    tty,
    depth,
    styled: tty || Boolean(forced),
    glyphs: pickGlyphs(env),
    cols: Math.max(60, Math.min(stream?.columns || 100, 110)),
  });
}

export function makeTerminal({
  tty = true,
  depth = 24,
  styled = true,
  glyphs = "rich",
  cols = 100,
}) {
  const cache = new Map();
  const color = depth >= 4;
  return {
    tty,
    depth,
    // Attributes on a terminal even without colour (NO_COLOR keeps bold).
    styled,
    glyphs,
    g: glyphSets[glyphs] ?? glyphSets.rich,
    cols,
    props(style) {
      let p = cache.get(style);
      if (!p) cache.set(style, (p = styleProps(style, color)));
      return p;
    },
  };
}

// Lines of spans to text, one line per row. Trailing blanks are trimmed.
export function render(lines, term) {
  return lines
    .map((line) => {
      let out = "";
      // Neighbouring spans of one style go out under one escape.
      const runs = [];
      for (const [text, style] of line)
        if (runs.at(-1)?.[1] === style) runs.at(-1)[0] += text;
        else runs.push([text, style]);
      for (const [text, style] of runs) {
        const open = term.styled ? escape(term.props(style), term.depth) : "";
        out += open ? `${open}${text}\x1b[0m` : text;
      }
      return out.replace(/ +$/, "");
    })
    .join("\n");
}

// ---- Pieces the screens share ---------------------------------------------

export const INDENT = 2;

// A document: every line indented, and on a terminal a blank line above and
// below.
export function document(lines, term) {
  const pad = [s(" ".repeat(INDENT))];
  const body = lines.map((line) => (line.length ? [...pad, ...line] : line));
  return term.tty ? [[], ...body, []] : body;
}

// The width a document's lines may use.
export const room = (term) => term.cols - INDENT * 2;

// An error for stderr, with the command's usage when there is one: on a
// terminal a screen of its own ("✗ message" under the mark), otherwise
// "osiris: message" and the usage on the next line.
export function errorText(message, term, usage = null) {
  if (!term.tty)
    return [`osiris: ${message}`, usage].filter(Boolean).join("\n");
  const width = room(term);
  const lines = [
    ...banner(term),
    ...wrapLine(
      [s(term.g.cross, "err bold"), s(" "), s(message, "text")],
      width,
      2,
    ),
  ];
  if (usage)
    lines.push(
      [],
      ...fact("Usage", [s(usage, "accent")], width - 2).map((line) => [
        s("  "),
        ...line,
      ]),
    );
  return render(document(lines, term), term);
}

// The Osiris mark: the wordmark and its words, or the mark and name on one
// line. Only on a terminal: piped output starts with what it says.
export function banner(term, { full = false } = {}) {
  if (!term.tty) return [];
  if (full) return [...branding(), []];
  return [[s(term.g.mark, "brand bold"), s(" OSIRIS", "brand bold")], []];
}

// "TITLE ──────── note": a section heading with its rule.
export function heading(title, width, term, note = "") {
  const tail = note ? [s(note, "muted")] : [];
  const rule = Math.max(
    3,
    width - lineWidth([s(title)]) - 2 - (note ? lineWidth(tail) + 2 : 0),
  );
  return [
    s(title, "muted bold"),
    s("  " + term.g.rule.repeat(rule), "divider"),
    ...(note ? [s("  "), ...tail] : []),
  ];
}

// "label   value" with the labels in a column and a long value wrapped under
// itself; `value` is spans.
export function fact(label, value, width, labelWidth = 10, style = "muted") {
  return wrapLine(
    [s(label.padEnd(labelWidth), style), ...value],
    width,
    labelWidth,
  );
}

// A list entry: a mark, a name column and what follows, wrapped under itself.
export function entry(mark, name, value, width, nameWidth) {
  const head = [...mark, s(" "), s(name.padEnd(nameWidth), "bold")];
  const lead = lineWidth(head) + 1;
  return wrapLine([...head, s(" "), ...value], width, lead);
}

// A paragraph of one style.
export const paragraph = (text, width, style = "muted") =>
  wrapLine([s(text, style)], width);

// Outcome marks, in the terminal's glyphs.
export const marks = (g) => ({
  ok: [s(g.check, "ok bold")],
  done: [s(g.check, "ok bold")],
  same: [s(g.check, "muted")],
  fail: [s(g.cross, "err bold")],
  warn: [s(g.warn, "warn bold")],
  info: [s(g.dot, "muted")],
  skip: [s(g.ring, "muted")],
  next: [s(g.arrow, "accent bold")],
});

// The one-line answer to a command: "✓ Installed".
export const outcome = (term, text, kind = "done") => [
  ...marks(term.g)[kind],
  s(" "),
  s(text, kind === "fail" ? "err bold" : "bold"),
];

// A command's next step, in the accent colour.
export const next = (text, width, labelWidth = 10) =>
  fact("Next", [s(text, "accent bold")], width, labelWidth);

// Key hints: "↑↓ move · space tick · ⏎ reopen", the keys in the accent. A
// hint's third element is what a click on it does (pick.js).
export const hints = (pairs) =>
  pairs.flatMap(([key, what, action], i) => [
    ...(i ? [s(" · ", "divider")] : []),
    [...s(key, "accent bold"), ...(action ? [action] : [])],
    [...s(" " + what, "muted"), ...(action ? [action] : [])],
  ]);

export { s, wrapLine };
