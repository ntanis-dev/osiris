// Text for the terminal (after Baton's and Pelican's): cleaned of control
// sequences, measured in terminal cells (wide CJK and emoji take two,
// combining marks none), and the words for amounts and times.
const escapes =
  /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-Z\\-_])/g;
const controls = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
const zeroWidth = /^[\p{Mn}\p{Me}\p{Cf}]$/u;

export function clean(text) {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(escapes, "")
    .replace(/\t/g, "  ")
    .replace(controls, "");
}

function wide(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x1fa70 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

export function charWidth(ch) {
  const cp = ch.codePointAt(0);
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (zeroWidth.test(ch)) return 0;
  return wide(cp) ? 2 : 1;
}

export function width(text) {
  let cells = 0;
  for (const ch of String(text)) cells += charWidth(ch);
  return cells;
}

export const plural = (n, word, many = `${word}s`) =>
  `${n} ${n === 1 ? word : many}`;

const pad2 = (n) => String(n).padStart(2, "0");
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");

export function hhmm(ms) {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// Local wall-clock time: 15:20 today, "Sat 09:00" within a week, "Oct 30"
// further away.
export function when(ms, now = Date.now()) {
  if (ms == null || !Number.isFinite(ms)) return "?";
  const d = new Date(ms);
  if (d.toDateString() === new Date(now).toDateString()) return hhmm(ms);
  if (Math.abs(ms - now) < 6.5 * 864e5)
    return `${DAYS[d.getDay()]} ${hhmm(ms)}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

// Shown paths: the home folder as ~ and forward slashes.
export function tildify(path, home) {
  if (!path) return "";
  const norm = (p) => String(p).replace(/\\/g, "/");
  const a = norm(path);
  const h = norm(home).replace(/\/$/, "");
  return a.toLowerCase() === h.toLowerCase()
    ? "~"
    : a.toLowerCase().startsWith(h.toLowerCase() + "/")
      ? "~" + a.slice(h.length)
      : a;
}
