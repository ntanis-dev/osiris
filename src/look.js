import { s } from "./lines.js";

// The look of every screen (after Baton's and Pelican's): one palette of
// roles, the header's colours (the dawn's gold, the mended window's green),
// and two glyph sets: "rich" for terminals with modern fonts (Windows
// Terminal, VS Code, macOS and Linux terminals), "plain" for the classic
// Windows console host. OSIRIS_GLYPHS=rich|plain overrides the guess. Text
// takes the terminal's own foreground, so a light scheme reads as well as a
// dark one.
export const roles = {
  accent: "#e8a33d",
  brand: "#f2c46d",
  ok: "#4fbf8f",
  warn: "#e8a33d",
  err: "#e07a6c",
  info: "#8fb3d9",
  muted: "#8b949e",
  divider: "#5c5244",
  text: null,
};

export const glyphSets = {
  rich: {
    mark: "◓",
    check: "✓",
    cross: "✗",
    warn: "!",
    dot: "●",
    ring: "○",
    tick: "●",
    untick: "○",
    cursor: "›",
    arrow: "›",
    sep: "·",
    rule: "─",
    up: "↑",
    down: "↓",
    enter: "⏎",
    less: "-",
  },
  plain: {
    mark: "-o-",
    check: "+",
    cross: "x",
    warn: "!",
    dot: "*",
    ring: "o",
    tick: "[x]",
    untick: "[ ]",
    cursor: ">",
    arrow: ">",
    sep: "·",
    rule: "─",
    up: "↑",
    down: "↓",
    enter: "Enter",
    less: "-",
  },
};

export function pickGlyphs(env = process.env, platform = process.platform) {
  const forced = String(env.OSIRIS_GLYPHS ?? "").toLowerCase();
  if (forced === "rich" || forced === "plain") return forced;
  if (platform !== "win32") return "rich";
  if (
    env.WT_SESSION ||
    env.TERM_PROGRAM ||
    env.ConEmuANSI === "ON" ||
    /xterm|mintty|alacritty|wezterm|kitty/i.test(env.TERM ?? "")
  )
    return "rich";
  return "plain";
}

const ATTRIBUTES = ["bold", "dim", "italic", "underline", "inverse"];

// A style's attributes and colour: { bold, dim, ..., color }. Without colour
// only the attributes stay.
export function styleProps(style, color) {
  const props = {};
  for (const word of String(style ?? "").split(" ")) {
    if (!word) continue;
    if (ATTRIBUTES.includes(word)) props[word] = true;
    else if (color && word in roles && roles[word]) props.color = roles[word];
  }
  return props;
}

// The wordmark (figlet's slant, as Baton's), and the words under it.
export const logo = [
  "   ____  _____ ________  _________",
  "  / __ \\/ ___//  _/ __ \\/  _/ ___/",
  " / / / /\\__ \\ / // /_/ // / \\__ \\",
  "/ /_/ /___/ // // _, _// / ___/ /",
  "\\____//____/___/_/ |_/___//____/",
];
export const slogan = "Every Claude Code window back after a sudden restart.";
export const motto = [
  "Each in its folder, on its conversation.",
  "Plain claude or Baton.",
];
export const branding = () => [
  ...logo.map((line) => [s(line, "brand bold")]),
  [],
  [s(slogan, "accent bold")],
  ...motto.map((line) => [s(line, "muted")]),
];
