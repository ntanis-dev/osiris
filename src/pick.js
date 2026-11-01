import { lineWidth, s } from "./lines.js";
import { INDENT, render } from "./term.js";

// The interactive list a restore chooses from, on a screen of its own (the
// terminal's alternate screen: nothing else shows, and the shell's screen
// comes back as it was). Up and down (or k and j) move, space ticks, a ticks
// all or none, enter goes on, q, Esc or Ctrl+C stop; with the mouse, a click
// on a window ticks it, the wheel moves, and the footer's keys are buttons.
// The header stays at the top and the footer at the bottom, the windows
// scroll between them by whole windows. It draws lines of spans like every
// other screen (term.js).
//
// pick({ count, checked, header, block, footer, term, input, output, mouse })
// resolves to the ticked indexes, or null when stopped. block(i, { ticked,
// current, width }) gives a window's lines, footer({ ticked, count, first,
// last }) the footer's spans; a span's third element is what a click on it
// does (toggle, all, enter or cancel).

const KEYS = [
  ["\x1b[A", "up"],
  ["\x1bOA", "up"],
  ["\x1b[B", "down"],
  ["\x1bOB", "down"],
  ["\x1b[H", "home"],
  ["\x1b[1~", "home"],
  ["\x1b[F", "end"],
  ["\x1b[4~", "end"],
  ["\x1b[5~", "pageup"],
  ["\x1b[6~", "pagedown"],
  ["\r\n", "enter"],
  ["\r", "enter"],
  ["\n", "enter"],
  ["\x03", "cancel"],
  [" ", "toggle"],
  ["k", "up"],
  ["j", "down"],
  ["a", "all"],
  ["q", "cancel"],
];

// A mouse report in the SGR form the screen asks for (?1006).
const MOUSE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/;
// The start of a sequence the next chunk finishes.
const PARTIAL = /\x1b(\[[?<>=]?[0-9;]*|O)?$/;
// How long a lone escape waits for the rest of a sequence before it is Esc.
const ESCAPE_MS = 25;

// The keys in a chunk of input, in order: names, and { x, y, kind, button }
// for the mouse (cells from 0; kind press, release, move, wheelup or
// wheeldown). An escape on its own is Esc.
export function parseKeys(chunk) {
  const out = [];
  let rest = String(chunk);
  while (rest.length) {
    const mouse = MOUSE.exec(rest);
    if (mouse) {
      const bits = Number(mouse[1]);
      out.push({
        x: Number(mouse[2]) - 1,
        y: Number(mouse[3]) - 1,
        kind:
          bits & 64
            ? bits & 1
              ? "wheeldown"
              : "wheelup"
            : mouse[4] === "m"
              ? "release"
              : bits & 32
                ? "move"
                : "press",
        button: bits & 3,
      });
      rest = rest.slice(mouse[0].length);
      continue;
    }
    const found = KEYS.find(([seq]) => rest.startsWith(seq));
    if (found) {
      out.push(found[1]);
      rest = rest.slice(found[0].length);
    } else if (rest[0] === "\x1b") {
      // An unknown sequence is skipped whole; a lone escape is Esc.
      const m = /^\x1b(\[[?<>=]?[0-9;]*[A-Za-z~]|O[A-Za-z])/.exec(rest);
      if (m) rest = rest.slice(m[0].length);
      else {
        out.push("cancel");
        rest = rest.slice(1);
      }
    } else rest = rest.slice(1);
  }
  return out;
}

const ENTER = "\x1b[?1049h\x1b[?7l\x1b[?25l\x1b[H\x1b[2J";
const LEAVE = "\x1b[?7h\x1b[?25h\x1b[?1049l";
const MOUSE_ON = "\x1b[?1000h\x1b[?1006h";
const MOUSE_OFF = "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l";
const SIGNALS = { SIGTERM: 143, SIGHUP: 129, SIGBREAK: 149 };

export function pick({
  count,
  checked = Array.from({ length: count }, () => true),
  header = [],
  block,
  footer,
  term,
  input = process.stdin,
  output = process.stdout,
  mouse = true,
}) {
  const ticks = Array.from({ length: count }, (_, i) => Boolean(checked[i]));
  let cursor = 0;
  let offset = 0;
  // Where the last frame put things, for the mouse: the window on each row,
  // the footer's row and its buttons.
  let owners = [];
  let footerRow = -1;
  let buttons = [];

  function draw() {
    // The layout width of term.js, from the terminal as it is now.
    const cols = Math.max(60, Math.min(output.columns || 100, 110));
    const rows = Math.max(8, output.rows || 40);
    const width = cols - INDENT * 2;
    // A short terminal keeps the windows in view: the header gives way, from
    // the top.
    let head = header;
    while (head.length && rows - 5 - head.length < 3) head = head.slice(1);
    const top = 1 + head.length;
    const height = rows - 4 - top;
    const blocks = Array.from({ length: count }, (_, i) =>
      block(i, { ticked: ticks[i], current: i === cursor, width }),
    );
    const span = (from, to) =>
      blocks.slice(from, to + 1).reduce((sum, b) => sum + b.length, 0);
    if (cursor < offset) offset = cursor;
    while (offset < cursor && span(offset, cursor) > height) offset++;

    const screen = Array.from({ length: rows - 1 }, () => []);
    head.forEach((line, i) => (screen[1 + i] = line));
    owners = [];
    let y = top;
    let last = offset;
    for (let i = offset; i < count; i++) {
      let lines = blocks[i];
      // The first window shown needs no blank line above it.
      if (i === offset)
        while (lines.length > 1 && !lines[0].length) lines = lines.slice(1);
      if (i > offset && y - top + lines.length > height) break;
      for (const line of lines) {
        if (y >= top + height) break;
        if (line.length) owners[y] = i;
        screen[y++] = line;
      }
      last = i + 1;
    }
    screen[rows - 3] = [s(term.g.rule.repeat(width), "divider")];
    const foot = footer({
      ticked: ticks.filter(Boolean).length,
      count,
      first: offset,
      last,
    });
    screen[rows - 2] = foot;
    footerRow = rows - 2;
    buttons = [];
    let x = INDENT;
    for (const part of foot) {
      const w = lineWidth([part]);
      if (part[2]) buttons.push({ from: x, to: x + w, action: part[2] });
      x += w;
    }

    const pad = [s(" ".repeat(INDENT))];
    let frame = "";
    screen.forEach((line, row) => {
      const text = render([line.length ? [...pad, ...line] : line], term);
      frame += `\x1b[${row + 1};1H${text}\x1b[K`;
    });
    output.write(frame);
  }

  return new Promise((resolve) => {
    const raw = typeof input.setRawMode === "function" && input.isTTY;
    let held = "";
    let timer = null;
    let left = false;
    const leave = () => {
      if (left) return;
      left = true;
      try {
        output.write((mouse ? MOUSE_OFF : "") + LEAVE);
      } catch {
        // the terminal may be gone
      }
    };
    const stops = Object.entries(SIGNALS).map(([signal, code]) => {
      const stop = () => {
        leave();
        process.exit(code);
      };
      process.on(signal, stop);
      return [signal, stop];
    });
    process.on("exit", leave);

    function finish(result) {
      clearTimeout(timer);
      input.off("data", onData);
      output.off?.("resize", draw);
      process.off("exit", leave);
      for (const [signal, stop] of stops) process.off(signal, stop);
      if (raw) input.setRawMode(false);
      input.pause?.();
      leave();
      resolve(result);
    }

    // One key or click; true once the list is done.
    function act(key) {
      if (typeof key === "object") {
        if (key.kind === "wheelup") return act("up");
        if (key.kind === "wheeldown") return act("down");
        if (key.kind !== "press" || key.button !== 0) return false;
        if (key.y === footerRow) {
          const button = buttons.find((b) => key.x >= b.from && key.x < b.to);
          return button ? act(button.action) : false;
        }
        if (owners[key.y] === undefined) return false;
        cursor = owners[key.y];
        return act("toggle");
      }
      if (key === "up") cursor = Math.max(0, cursor - 1);
      else if (key === "down") cursor = Math.min(count - 1, cursor + 1);
      else if (key === "home") cursor = 0;
      else if (key === "end") cursor = count - 1;
      else if (key === "pageup") cursor = Math.max(0, cursor - 5);
      else if (key === "pagedown") cursor = Math.min(count - 1, cursor + 5);
      else if (key === "toggle") ticks[cursor] = !ticks[cursor];
      else if (key === "all") ticks.fill(!ticks.every(Boolean));
      else if (key === "enter") {
        finish(ticks.flatMap((t, i) => (t ? [i] : [])));
        return true;
      } else if (key === "cancel") {
        finish(null);
        return true;
      }
      return false;
    }

    function take(text) {
      for (const key of parseKeys(text)) if (act(key)) return;
      draw();
    }

    function onData(chunk) {
      clearTimeout(timer);
      let text = held + chunk;
      held = "";
      // A sequence cut between chunks waits for its rest; a lone escape that
      // stays alone is Esc.
      const tail = PARTIAL.exec(text);
      if (tail) {
        held = tail[0];
        text = text.slice(0, tail.index);
        timer = setTimeout(() => {
          const rest = held;
          held = "";
          take(rest);
        }, ESCAPE_MS);
      }
      if (text) take(text);
    }

    output.write(ENTER + (mouse ? MOUSE_ON : ""));
    if (raw) input.setRawMode(true);
    input.setEncoding?.("utf8");
    input.on("data", onData);
    output.on?.("resize", draw);
    input.resume?.();
    draw();
  });
}
