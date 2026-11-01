import { charWidth, clean, width } from "./text.js";

// Every screen is built as lines of spans, [text, style], measured in
// terminal cells (Baton's and Pelican's way); term.js draws them. A style is
// space-separated words: bold, dim, italic, underline, or one of the
// palette's roles (look.js).
export const s = (text, style = "") => [clean(text).replace(/\n/g, " "), style];
export const lineWidth = (line) =>
  line.reduce((sum, [text]) => sum + width(text), 0);

// Exactly `cells` wide: padded with `fill`'s style. A line that was not made
// to fit is cut at the edge as a last resort (the screens wrap instead, so
// this does not happen in practice).
export function fitLine(line, cells, fill = "") {
  const out = [];
  let used = 0;
  for (const [text, style] of line) {
    if (used >= cells) break;
    const w = width(text);
    if (used + w <= cells) {
      out.push([text, style]);
      used += w;
      continue;
    }
    let part = "";
    for (const ch of text) {
      const cw = charWidth(ch);
      if (used + cw > cells) break;
      part += ch;
      used += cw;
    }
    out.push([part, style]);
    break;
  }
  if (used < cells) out.push([" ".repeat(cells - used), fill]);
  return out;
}

// Left and right parts on one line, the gap padded; a right part that does
// not fit is left out.
export function spread(left, right, cells, fill = "") {
  const room = cells - lineWidth(right);
  if (!right.length || room < lineWidth(left) + 1)
    return fitLine(left, cells, fill);
  return [...fitLine(left, room, fill), ...right];
}

// A line of spans wrapped to `cells`: at spaces where it can, inside a word
// longer than a line. Continuation lines start with `indent` spaces. Nothing
// is cut.
const breaks = new Set(["-", "/", "\\", ":", "_", "."]);
export function wrapLine(line, cells, indent = 0) {
  const room = Math.max(1, cells);
  const lead = Math.min(indent, Math.max(0, room - 1));
  const tokens = [];
  for (const [text, style] of line)
    for (const part of String(text).split(/( +)/))
      if (part) tokens.push([part, style]);
  const out = [];
  let current = [];
  let used = 0;
  const atStart = () => used === (out.length ? lead : 0);
  const flush = () => {
    while (current.length && /^ +$/.test(current.at(-1)[0])) {
      used -= width(current.at(-1)[0]);
      current.pop();
    }
    out.push(current);
    current = lead ? [[" ".repeat(lead), ""]] : [];
    used = lead;
  };
  for (const [text, style] of tokens) {
    const w = width(text);
    if (/^ +$/.test(text)) {
      if (out.length && atStart()) continue;
      if (used + w > room) {
        flush();
        continue;
      }
      current.push([text, style]);
      used += w;
      continue;
    }
    if (used + w > room && !atStart() && w <= room - lead) flush();
    if (used + w <= room) {
      current.push([text, style]);
      used += w;
      continue;
    }
    let rest = [...text];
    while (rest.length) {
      let cells2 = 0;
      let fits = 0;
      let mark = 0;
      for (const ch of rest) {
        cells2 += charWidth(ch);
        if (used + cells2 > room) break;
        fits++;
        if (breaks.has(ch)) mark = fits;
      }
      if (fits === rest.length) {
        current.push([rest.join(""), style]);
        used += cells2;
        break;
      }
      if (!mark && !atStart()) {
        flush();
        continue;
      }
      const take = mark || fits || 1;
      current.push([rest.slice(0, take).join(""), style]);
      used += width(rest.slice(0, take).join(""));
      rest = rest.slice(take);
      flush();
    }
  }
  if (current.length && !(out.length && atStart())) flush();
  return out.length ? out : [[]];
}

// Facts (each a list of spans) joined by a separator into one line, wrapped
// under `indent`.
export function joinFacts(facts, sep = [" · ", "divider"]) {
  const out = [];
  for (const fact of facts) {
    if (!fact?.length) continue;
    if (out.length) out.push(sep);
    out.push(...fact);
  }
  return out;
}
