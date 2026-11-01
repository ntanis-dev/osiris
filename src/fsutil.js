import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";

// Small synchronous file helpers. State files are replaced atomically (a
// temporary file in the same folder, then a rename), so a reader never sees
// half a file, not even after a crash in the middle of a write.

const sleeper = new Int32Array(new SharedArrayBuffer(4));
export const sleepSync = (ms) => Atomics.wait(sleeper, 0, 0, ms);

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function readText(file, fallback = null) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return fallback;
  }
}

export function writeFileAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = join(
    dirname(file),
    `.${basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
  );
  writeFileSync(tmp, text);
  // Windows refuses a rename over a file another process has open without
  // delete sharing (a virus scanner, an editor); retry briefly.
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (error) {
      if (attempt >= 6 || !["EPERM", "EACCES", "EBUSY"].includes(error.code)) {
        rmSync(tmp, { force: true });
        throw error;
      }
      sleepSync(5 * (attempt + 1));
    }
  }
}

export const writeJsonAtomic = (file, value) =>
  writeFileAtomic(file, JSON.stringify(value, null, 2) + "\n");

// The last `bytes` of a file as whole lines (the first, cut line is
// dropped), or null when it cannot be read. Transcripts grow to hundreds of
// megabytes; what Osiris needs from them is near the end.
export function readTailLines(file, bytes = 4 << 20) {
  let fd;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split("\n");
    if (length < size) lines.shift();
    return lines.filter((line) => line.trim());
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export const iso = (ms) => new Date(ms).toISOString();

export function ms(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const t = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

export function isAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
