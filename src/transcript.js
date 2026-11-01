import { readTailLines } from "./fsutil.js";

// What a conversation's transcript (<project>/<session>.jsonl) says about it,
// read from its last few megabytes only:
//   title           its /rename title, else Claude's title for it, else its
//                   last prompt
//   model, effort   what its last answer asked for (the model as it was
//                   chosen, "claude-opus-5-5[1m]" included); a resume does
//                   not restore them by itself
//   permissionMode  the mode it was in last
//   cwd, entrypoint the last entry's (cwds: every folder it names)
//   continuedIn     the session it went on in, if it did
//   lastAt          the last entry's time
// or null when the file cannot be read.

const clip = (value, n) => {
  if (typeof value !== "string") return null;
  const flat = value.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length > n ? flat.slice(0, n - 1).trimEnd() + "…" : flat;
};

export function transcriptInfo(file, { bytes } = {}) {
  const lines = readTailLines(file, bytes);
  if (!lines) return null;
  const info = {
    title: null,
    model: null,
    effort: null,
    permissionMode: null,
    cwd: null,
    cwds: [],
    entrypoint: null,
    continuedIn: null,
    lastAt: null,
  };
  let custom = null;
  let ai = null;
  let agent = null;
  let prompt = null;
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    if (typeof entry.cwd === "string") {
      info.cwd = entry.cwd;
      if (!info.cwds.includes(entry.cwd)) info.cwds.push(entry.cwd);
    }
    if (typeof entry.entrypoint === "string")
      info.entrypoint = entry.entrypoint;
    if (typeof entry.timestamp === "string") info.lastAt = entry.timestamp;
    switch (entry.type) {
      case "custom-title":
        custom = entry.customTitle ?? custom;
        break;
      case "ai-title":
        ai = entry.aiTitle ?? ai;
        break;
      case "agent-name":
        agent = entry.agentName ?? agent;
        break;
      case "last-prompt":
        prompt = entry.lastPrompt ?? prompt;
        break;
      case "permission-mode":
        if (typeof entry.permissionMode === "string")
          info.permissionMode = entry.permissionMode;
        break;
      case "continued-in":
        if (typeof entry.continuedInSessionId === "string")
          info.continuedIn = entry.continuedInSessionId;
        break;
      case "user":
        if (typeof entry.permissionMode === "string")
          info.permissionMode = entry.permissionMode;
        break;
      case "assistant": {
        const model = entry.requestedModel ?? entry.message?.model;
        if (typeof model === "string" && !model.startsWith("<"))
          info.model = model;
        if (typeof entry.effort === "string") info.effort = entry.effort;
        break;
      }
    }
  }
  info.title =
    clip(custom, 80) ?? clip(ai, 80) ?? clip(agent, 80) ?? clip(prompt, 80);
  return info;
}
