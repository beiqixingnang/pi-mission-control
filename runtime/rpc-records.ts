import type { Readable } from "node:stream";

/** Pi emits type first. These snapshots repeat already delivered canonical messages. */
const redundant = /^\s*\{\s*"type"\s*:\s*"(?:agent_end|turn_end)"\s*[,}]/;
const eventTypes = new Set([
  "response",
  "agent_start",
  "agent_end",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "agent_settled",
  "extension_ui_request",
  "auto_retry_start",
  "auto_retry_end",
  "auto_compaction_start",
  "auto_compaction_end",
]);
export interface RpcRecordDiagnostic {
  code: "RPC_RECORD_TOO_LARGE" | "RPC_RECORD_INCOMPLETE";
  eventType: string;
  observedBytesLowerBound: number;
  limitBytes: number;
  /** 1-based LF record index, including ignored snapshots and empty records. */
  recordIndex: number;
}
export class RpcRecordError extends Error {
  diagnostic: RpcRecordDiagnostic;
  constructor(diagnostic: RpcRecordDiagnostic) {
    super(
      `Worker ${diagnostic.code === "RPC_RECORD_TOO_LARGE" ? "canonical RPC record exceeds size limit" : "RPC stream ended with an incomplete record"}: ${JSON.stringify(diagnostic)}`,
    );
    this.name = "RpcRecordError";
    this.diagnostic = diagnostic;
  }
}

/** Drain redundant snapshots without retaining their bodies; bound every other RPC record. */
export async function* rpcRecords(input: Readable, maxBytes = 8 * 1024 * 1024) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw Error("Invalid RPC record byte limit");
  let parts: Buffer[] = [],
    bytes = 0,
    prefix = "",
    discard = false,
    recordIndex = 1;
  const failure = (code: RpcRecordDiagnostic["code"]) => {
    const type = prefix.match(/^\s*\{\s*"type"\s*:\s*"([a-z_]+)"\s*[,}]/)?.[1];
    return new RpcRecordError({
      code,
      eventType: type && eventTypes.has(type) ? type : "unknown",
      observedBytesLowerBound: bytes,
      limitBytes: maxBytes,
      recordIndex,
    });
  };
  const reset = () => {
    parts = [];
    bytes = 0;
    prefix = "";
    discard = false;
  };
  const add = (part: Buffer) => {
    bytes += part.length;
    if (discard) return;
    if (prefix.length < 4096)
      prefix += part.subarray(0, 4096 - prefix.length).toString("utf8");
    if (redundant.test(prefix)) {
      discard = true;
      parts = [];
      return;
    }
    if (bytes > maxBytes) throw failure("RPC_RECORD_TOO_LARGE");
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
      recordIndex++;
      start = end + 1;
    }
    if (start < chunk.length) add(chunk.subarray(start));
  }
  // An unterminated record cannot prove a successful worker settlement.
  if (bytes || discard) throw failure("RPC_RECORD_INCOMPLETE");
}
