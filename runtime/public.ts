import fs from "node:fs";
import { once } from "node:events";
import type { Writable } from "node:stream";
import { lfLines } from "./jsonl.ts";

export function textOf(message: any): string {
  if (typeof message?.content === "string") return message.content;
  return Array.isArray(message?.content)
    ? message.content
        .filter((b: any) => b?.type === "text" && typeof b.text === "string")
        .map((b: any) => b.text)
        .join("\n")
    : "";
}
export function cleanText(value: string, max = 2000) {
  return Array.from(
    value
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/[\x00-\x08\x0b-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, ""),
  )
    .slice(0, max)
    .join("");
}
export function exportText(value: string, max = 32000) {
  if (
    /"(?:thinking|reasoning|thinkingSignature|systemPrompt|apiKey|authorization)"\s*:/.test(
      value,
    ) ||
    /"role"\s*:\s*"(?:system|developer)"/.test(value)
  )
    return "[Embedded private/session dump omitted from public export]";
  return cleanText(
    value.replace(
      /<(think|thinking|reasoning|analysis)(?:\s[^>]*)?>[\s\S]*?(?:<\/\1>|$)/gi,
      "[Private block omitted]",
    ),
    max,
  );
}
/** Structural allowlist: no reasoning/signatures/system bodies in public exports. */
export function publicEntry(entry: any) {
  if (entry?.type === "message") {
    const m = entry.message;
    if (!["user", "assistant", "toolResult", "custom"].includes(m?.role))
      return;
    const content =
      typeof m.content === "string"
        ? exportText(m.content, 32000)
        : (m.content ?? []).flatMap((b: any) => {
            if (b?.type === "text")
              return [{ type: "text", text: exportText(b.text ?? "", 32000) }];
            if (b?.type === "toolCall")
              return [
                {
                  type: "toolCall",
                  id: b.id,
                  name: b.name,
                  arguments: scrub(b.arguments),
                },
              ];
            return [];
          });
    return {
      type: "message",
      id: entry.id,
      parentId: entry.parentId,
      timestamp: entry.timestamp,
      role: m.role,
      toolName: m.toolName,
      toolCallId: m.toolCallId,
      isError: m.isError,
      content,
    };
  }
  if (entry?.type === "custom_message")
    return {
      type: "custom_message",
      id: entry.id,
      parentId: entry.parentId,
      timestamp: entry.timestamp,
      customType: entry.customType,
      content: exportText(textOf(entry), 32000),
    };
  if (entry?.type === "compaction")
    return {
      type: "compaction",
      id: entry.id,
      parentId: entry.parentId,
      timestamp: entry.timestamp,
      summary: exportText(entry.summary ?? "", 64000),
    };
}
function scrub(value: any, depth = 0): any {
  if (depth > 10) return "[depth limit]";
  if (typeof value === "string") return exportText(value, 16000);
  if (Array.isArray(value))
    return value.slice(0, 100).map((v) => scrub(v, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([k]) =>
            !/thinking|reasoning|signature|system.?prompt|api.?key|secret|authorization/i.test(
              k,
            ),
        )
        .map(([k, v]) => [k, scrub(v, depth + 1)]),
    );
  return value;
}
export async function streamPublicSession(
  file: string,
  out: Writable,
  signal?: AbortSignal,
) {
  const input = fs.createReadStream(file);
  let count = 0;
  try {
    for await (const line of lfLines(input)) {
      signal?.throwIfAborted();
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const row = publicEntry(entry);
      if (row) {
        if (!out.write(JSON.stringify(row) + "\n")) await once(out, "drain");
        count++;
      }
    }
  } finally {
    input.destroy();
  }
  return count;
}
