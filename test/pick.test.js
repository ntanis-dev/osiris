import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { parseKeys, pick } from "../src/pick.js";
import { s } from "../src/lines.js";
import { makeTerminal } from "../src/term.js";

class Screen extends Writable {
  constructor() {
    super();
    this.text = "";
    this.columns = 60;
    this.rows = 12;
  }
  _write(chunk, _enc, done) {
    this.text += chunk.toString();
    done();
  }
}

const term = makeTerminal({ styled: false, glyphs: "plain" });
// The frames as text: each row on a line of its own.
const plainText = (text) =>
  text.replace(/\x1b\[\d+;1H/g, "\n").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
// A click at a cell (from 0), as the terminal reports it.
const click = (x, y) => `\x1b[<0;${x + 1};${y + 1}M\x1b[<0;${x + 1};${y + 1}m`;

function chooser(rows, extra = {}) {
  const input = new PassThrough();
  const output = new Screen();
  const result = pick({
    count: rows.length,
    header: [[s("Pick:")]],
    block: (i, { ticked, current }) => [
      [s(`${current ? ">" : " "} ${ticked ? "[x]" : "[ ]"} ${rows[i]}`)],
      [s(`    detail ${i}`)],
    ],
    footer: ({ ticked, count, first, last }) => [
      s(`${ticked} ticked · ${first + 1}-${last} of ${count} `),
      [...s("reopen"), "enter"],
    ],
    term,
    input,
    output,
    ...extra,
  });
  return { input, output, result };
}

test("keys, clicks and escape sequences are read in order", () => {
  assert.deepEqual(parseKeys("\x1b[A\x1b[Bjk a\r"), [
    "up",
    "down",
    "down",
    "up",
    "toggle",
    "all",
    "enter",
  ]);
  assert.deepEqual(parseKeys("\x1b"), ["cancel"]);
  assert.deepEqual(parseKeys("\x1b[2~x\x1b[?1u\x03"), ["cancel"]);
  assert.deepEqual(parseKeys("\x1b[<0;3;5M\x1b[<65;1;1M"), [
    { x: 2, y: 4, kind: "press", button: 0 },
    { x: 0, y: 0, kind: "wheeldown", button: 1 },
  ]);
});

test("the list returns the ticked windows, or null when stopped", async () => {
  const { input, output, result } = chooser(["one", "two", "three"], {
    checked: [true, false, true],
  });
  input.write("j ");
  input.write("j ");
  input.write("\r");
  assert.deepEqual(await result, [0, 1]);
  assert.match(plainText(output.text), /> \[x\] two/);
  assert.match(plainText(output.text), /2 ticked/);
  // On a screen of its own, given back at the end, the mouse with it.
  assert.ok(output.text.startsWith("\x1b[?1049h"));
  assert.ok(output.text.includes("\x1b[?1000h\x1b[?1006h"));
  assert.ok(output.text.endsWith("\x1b[?1049l"));
  assert.ok(
    output.text.lastIndexOf("\x1b[?1000l") >
      output.text.lastIndexOf("\x1b[?1000h"),
  );

  const stopped = chooser(["one"]);
  stopped.input.write("q");
  assert.equal(await stopped.result, null);

  const none = chooser(["a", "b"]);
  none.input.write("a\r");
  assert.deepEqual(await none.result, []);
});

test("a click ticks a window, the wheel moves, and the footer's buttons work", async () => {
  // Row 0 is blank and row 1 the header, so the windows start on row 2,
  // two rows each; the footer is on the second row from the bottom.
  const { input, output, result } = chooser(["one", "two", "three"], {
    checked: [true, true, true],
  });
  input.write(click(4, 4));
  assert.match(plainText(output.text), /> \[ \] two/);
  input.write("\x1b[<65;5;5M");
  assert.match(plainText(output.text), /> \[x\] three/);
  // A click on the header does nothing.
  input.write(click(4, 1));
  // "reopen" comes after "2 ticked · 1-3 of 3 " (20 cells) and the indent.
  input.write(click(2 + 20 + 2, 12 - 2));
  assert.deepEqual(await result, [0, 2]);
});

test("a mouse report cut in two is not taken for Esc", async () => {
  const { input, result } = chooser(["one", "two"]);
  input.write("\x1b[<0;5");
  input.write(";5M\r");
  assert.deepEqual(await result, [0]);
});

test("a list taller than the terminal scrolls by whole windows", async () => {
  const rows = Array.from({ length: 30 }, (_, i) => `row ${i}`);
  const { input, output, result } = chooser(rows);
  input.write("\x1b[F");
  input.write("\r");
  assert.equal((await result).length, 30);
  const text = plainText(output.text);
  assert.match(text, /> \[x\] row 29/);
  assert.match(text, /of 30/);
  // Each window shows whole: its detail line comes with it.
  assert.match(text, /row 29\n\s+detail 29/);
});

test("without the mouse, the screen does not ask for it", async () => {
  const { input, output, result } = chooser(["one"], { mouse: false });
  input.write("\r");
  await result;
  assert.ok(!output.text.includes("\x1b[?1000h"));
  assert.ok(output.text.endsWith("\x1b[?1049l"));
});
