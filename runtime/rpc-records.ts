import type { Readable } from "node:stream";

/** Pi emits type first. These snapshots repeat already delivered canonical messages. */
const redundant = /^\s*\{\s*"type"\s*:\s*"(?:agent_end|turn_end)"\s*[,}]/;

/** Drain redundant snapshots without retaining their bodies; bound every other RPC record. */
export async function* rpcRecords(input: Readable, maxBytes = 8 * 1024 * 1024) {
  let parts: Buffer[] = [],
    bytes = 0,
    prefix = "",
    discard = false;
  const reset = () => {
    parts = [];
    bytes = 0;
    prefix = "";
    discard = false;
  };
  const add = (part: Buffer) => {
    if (discard) return;
    if (prefix.length < 4096)
      prefix += part.subarray(0, 4096 - prefix.length).toString("utf8");
    if (redundant.test(prefix)) {
      discard = true;
      parts = [];
      return;
    }
    bytes += part.length;
    if (bytes > maxBytes)
      throw Error(
        "Worker canonical RPC record exceeds 8 MiB; inspect its event type and saved artifacts",
      );
    parts.push(part);
  };
  for await (const value of input) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    let start = 0,
      end: number;
    while ((end = chunk.indexOf(10, start)) !== -1) {
      add(chunk.subarray(start, end));
      if (!discard && bytes) yield Buffer.concat(parts, bytes).toString("utf8");
      reset();
      start = end + 1;
    }
    if (start < chunk.length) add(chunk.subarray(start));
  }
  // An unterminated record cannot prove a successful worker settlement.
  if (bytes || discard)
    throw Error("Worker RPC stream ended with an incomplete record");
}
