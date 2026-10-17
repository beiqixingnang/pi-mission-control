import fs from "node:fs/promises";
import path from "node:path";
import { publicEntry } from "./public.ts";

export interface TranscriptRecord {
  offset: number;
  entry: any;
}
export interface TranscriptPage {
  records: TranscriptRecord[];
  before: number;
  end: number;
  skipped: boolean;
}

/** Backward LF pages: bounded I/O and memory, never stringify/read a whole session. */
export async function transcriptPage(
  file: string,
  before?: number,
  limit = 40,
  scanBudget = 4 * 1024 * 1024,
): Promise<TranscriptPage> {
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat();
    const end = Math.min(before ?? stat.size, stat.size);
    let position = end,
      scanned = 0,
      bytes = 0,
      oversized = false,
      skipped = false;
    let fragments: Buffer[] = [];
    const records: TranscriptRecord[] = [];
    const last = Buffer.alloc(1);
    if (end) await handle.read(last, 0, 1, end - 1);
    // A writer may currently be appending a record; never parse a partial tail.
    let discard = end > 0 && last[0] !== 10;
    const add = (part: Buffer) => {
      bytes += part.length;
      if (bytes <= 1024 * 1024) fragments.unshift(part);
      else {
        oversized = true;
        skipped = true;
        fragments = [];
      }
    };
    const flush = (offset: number) => {
      if (!discard && !oversized && bytes) {
        try {
          const entry = publicEntry(
            JSON.parse(Buffer.concat(fragments, bytes).toString("utf8")),
          );
          if (entry) records.push({ offset, entry });
        } catch {
          skipped = true;
        }
      }
      discard = false;
      fragments = [];
      bytes = 0;
      oversized = false;
    };
    while (position > 0 && scanned < scanBudget) {
      const count = Math.min(65536, position, scanBudget - scanned);
      const start = position - count,
        chunk = Buffer.alloc(count);
      const { bytesRead } = await handle.read(chunk, 0, count, start);
      if (bytesRead !== count) {
        skipped = true;
        break;
      }
      scanned += count;
      let tail = count;
      for (let i = count - 1; i >= 0; i--) {
        if (chunk[i] !== 10) continue;
        add(chunk.subarray(i + 1, tail));
        flush(start + i + 1);
        if (records.length >= limit)
          return {
            records: records.reverse(),
            before: start + i + 1,
            end,
            skipped,
          };
        tail = i;
      }
      add(chunk.subarray(0, tail));
      position = start;
    }
    if (position === 0) flush(0);
    else skipped = true;
    return { records: records.reverse(), before: position, end, skipped };
  } finally {
    await handle.close();
  }
}

/** Only regular logs from this runtime/member, including retired sessions. */
export async function memberSessionFiles(directory: string, memberId: string) {
  if (!/^[\w-]+$/.test(memberId)) throw new Error("Invalid member identity");
  const base = path.join(directory, "sessions", memberId);
  let names: string[];
  try {
    names = await fs.readdir(base);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: Array<{ path: string; modified: number }> = [];
  for (const name of names.filter((n) => n.endsWith(".jsonl"))) {
    const file = path.join(base, name),
      stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    files.push({ path: file, modified: stat.mtimeMs });
  }
  return files
    .sort((a, b) => b.modified - a.modified || a.path.localeCompare(b.path))
    .map((f) => f.path);
}
