/** Best-effort, read-only Windows current-directory holders. Never releases
 * foreign handles, changes another process's directory or terminates it.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";

export interface WorkspaceHolder {
  pid: number;
  parentPid: number;
  name: string;
  cwd: string;
  parentOfPi: boolean;
}
export interface WorkspaceLocks {
  supported: boolean;
  exhaustive: false;
  kind?: "process-cwd";
  inspected?: number;
  holders: WorkspaceHolder[];
  reason?: string;
}
export async function workspaceLocks(
  root: string,
  signal?: AbortSignal,
): Promise<WorkspaceLocks> {
  const unavailable = (reason: string): WorkspaceLocks => ({
    supported: false,
    exhaustive: false,
    holders: [],
    reason,
  });
  if (process.platform !== "win32")
    return unavailable("Windows-only process-directory diagnosis");
  if (signal?.aborted) return unavailable("Diagnosis cancelled");
  const script = fs.readFileSync(
    new URL("./workspace-locks.ps1", import.meta.url),
    "utf8",
  );
  const executable = path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32/WindowsPowerShell/v1.0/powershell.exe",
  );
  const env: NodeJS.ProcessEnv = {};
  for (const name of [
    "SystemRoot",
    "WINDIR",
    "PATH",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "LOCALAPPDATA",
    "PSModulePath",
    "ProgramFiles",
  ])
    if (process.env[name]) env[name] = process.env[name];
  return new Promise((resolve) => {
    const child = execFile(
      executable,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      {
        cwd: os.tmpdir(),
        env,
        windowsHide: true,
        timeout: 10000,
        maxBuffer: 256000,
        encoding: "utf8",
        signal,
      },
      (error, stdout) => {
        if (error) {
          resolve(
            unavailable(
              signal?.aborted
                ? "Diagnosis cancelled"
                : "Windows process-directory query unavailable",
            ),
          );
          return;
        }
        try {
          const value = JSON.parse(stdout.replace(/^\uFEFF/, ""));
          if (
            value.supported !== true ||
            value.kind !== "process-cwd" ||
            !Array.isArray(value.holders)
          )
            throw new Error("Invalid probe result");
          const holders = value.holders
            .filter(
              (holder: WorkspaceHolder) =>
                Number.isSafeInteger(holder.pid) &&
                Number.isSafeInteger(holder.parentPid) &&
                typeof holder.name === "string" &&
                typeof holder.cwd === "string" &&
                typeof holder.parentOfPi === "boolean",
            )
            .slice(0, 32);
          resolve({
            supported: true,
            exhaustive: false,
            kind: "process-cwd",
            inspected: value.inspected,
            holders,
          });
        } catch {
          resolve(
            unavailable(
              "Windows process-directory query returned an invalid result",
            ),
          );
        }
      },
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(
      JSON.stringify({
        root: path.resolve(root),
        leadPid: process.pid,
        parentPid: process.ppid,
      }),
    );
  });
}
