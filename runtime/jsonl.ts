import type { Readable } from "node:stream";

/** LF is the only record separator. U+2028/U+2029 are legal JSON string data. */
export async function* lfLines(
  input: Readable,
  maxLineBytes = 64 * 1024 * 1024,
): AsyncGenerator<string> {
  let pending: Buffer[] = [];
  let bytes = 0;
  for await (const value of input) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    let start = 0,
      end: number;
    while ((end = chunk.indexOf(10, start)) !== -1) {
      const segment = chunk.subarray(start, end);
      bytes += segment.length;
      if (bytes > maxLineBytes)
        throw new Error("JSONL record exceeds size limit");
      yield Buffer.concat([...pending, segment], bytes).toString("utf8");
      pending = [];
      bytes = 0;
      start = end + 1;
    }
    if (start < chunk.length) {
      const tail = chunk.subarray(start);
      bytes += tail.length;
      if (bytes > maxLineBytes)
        throw new Error("JSONL record exceeds size limit");
      pending.push(tail);
    }
  }
  if (bytes) yield Buffer.concat(pending, bytes).toString("utf8");
}
