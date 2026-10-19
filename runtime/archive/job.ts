import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

export interface ArchiveRequest {
  stateDirectory: string;
  sessionFile: string;
  destination: string;
  sessionId: string;
  leafId?: string;
  includeArchived?: boolean;
}
export interface ArchiveProgress {
  phase: string;
  source?: string;
  bytes?: number;
  total?: number;
  records?: number;
  sources?: number;
}
export interface ArchiveResult {
  destination: string;
  index: string;
  manifest: string;
  status: "complete" | "partial";
  sources: number;
  items: number;
  files: number;
  elapsedMs: number;
  notices: unknown[];
}
/** Export in a separate process with no Pi runtime owner or model credentials. */
export async function runArchive(
  request: ArchiveRequest,
  options: { signal?: AbortSignal; onProgress?: (value: ArchiveProgress) => void } = {},
): Promise<ArchiveResult> {
  options.signal?.throwIfAborted();
  const args = [fileURLToPath(new URL("./cli.mjs", import.meta.url)),
    "--state-dir", request.stateDirectory, "--session-file", request.sessionFile,
    "--session-id", request.sessionId, "--destination", request.destination];
  if (request.leafId) args.push("--leaf-id", request.leafId);
  if (request.includeArchived === false) args.push("--active-members-only");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ["PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "LANG", "LC_ALL"].includes(key.toUpperCase()),
  ));
  const child = spawn(process.execPath, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  return await new Promise<ArchiveResult>((resolve, reject) => {
    let result: ArchiveResult | undefined, pending = "", errors = "", timer: ReturnType<typeof setTimeout> | undefined;
    const decoder = new StringDecoder("utf8");
    const abort = () => {
      child.kill("SIGTERM");
      timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      timer.unref?.();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.on("data", (chunk) => {
      pending += decoder.write(chunk);
      if (pending.length > 128000) { child.kill(); return; }
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        try {
          const value = JSON.parse(line);
          if (value.type === "result") result = value.result;
          else if (value.type === "progress") options.onProgress?.(value);
        } catch { /* Child diagnostics cannot become model instructions. */ }
      }
    });
    child.stderr.on("data", chunk => { errors = (errors + chunk.toString("utf8")).slice(-8000); });
    child.once("error", reject);
    child.once("close", code => {
      options.signal?.removeEventListener("abort", abort);if(timer)clearTimeout(timer);
      if (options.signal?.aborted) {
        const partial = request.destination + ".partial";
        if (fs.existsSync(partial)) fs.writeFileSync(path.join(partial, "job.json"), JSON.stringify({status:"cancelled",at:new Date().toISOString()}));
        reject(new Error("Archive cancelled; the .partial directory records its state"));
      }
      else if (code === 0 && result) resolve(result);
      else reject(new Error(`Archive worker failed (${code}): ${errors || "No completion receipt"}`));
    });
  });
}
