import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { inside, resolveInput } from "../extensions/workspace/policy.ts";
import type { Member, ReviewHold, Task } from "./types.ts";
import type { Store } from "./store.ts";

/** Keep complete capability evidence on disk; routine status must not repeat role prompts per task. */
export function taskView(task: Task) {
  const {
    capabilitySnapshot,
    actualTools: _tools,
    continuation: _continuation,
    ...view
  } = task;
  return { ...view, capabilityRevision: capabilitySnapshot?.revision };
}

export function rebaseReviewHolds(
  store: Store,
  mapped: (value: string) => string,
) {
  for (const row of store.db
    .prepare("SELECT key,data FROM meta WHERE key LIKE 'reviewHold:%'")
    .all()) {
    const hold = JSON.parse(String(row.data)) as ReviewHold;
    hold.files = hold.files.map(mapped);
    if (hold.snapshotPath) hold.snapshotPath = mapped(hold.snapshotPath);
    if (hold.resultPath) hold.resultPath = mapped(hold.resultPath);
    store.set(String(row.key), hold);
  }
}

export function capabilityView(member: Member, actualTools?: string[]) {
  const workspace = member.workspace;
  return {
    revision: member.revision ?? 0,
    model: member.model,
    thinkingLevel: member.thinkingLevel,
    role: member.role,
    workspace,
    readRoots: [
      ...new Set([
        workspace.root,
        ...workspace.extraReadRoots,
        ...(workspace.extraWriteRoots ?? []),
      ]),
    ],
    writeRoots: [
      ...(workspace.access === "read-write" ? [workspace.root] : []),
      ...(workspace.extraWriteRoots ?? []),
    ],
    configuredTools: member.tools ?? "all permitted tools",
    actualTools: actualTools ?? null,
    communication: { allow: member.allow },
    executionNote:
      workspace.execution === "host"
        ? "Host commands have the host user's authority; file roots do not confine shell commands."
        : workspace.execution === "sandbox"
          ? "Container commands use the primary workspace and extra read roots; extra write roots apply to file tools only."
          : "File tools only; no command execution.",
  };
}

/** Hash the explicit review batch only, after the executor's process has settled. */
export function reviewSnapshot(
  member: Member,
  files: string[],
  allowMissing = false,
) {
  const roots = [
    member.workspace.root,
    ...member.workspace.extraReadRoots,
    ...(member.workspace.extraWriteRoots ?? []),
  ];
  let total = 0;
  return files.map((input) => {
    const target = resolveInput(input, member.workspace.root);
    const owner = roots.find((root) => inside(root, target));
    if (!owner)
      throw new Error(
        `Review file outside ${member.name}'s authorized roots: ${target}`,
      );
    let current = owner;
    for (const part of [
      "",
      ...path.relative(owner, target).split(path.sep).filter(Boolean),
    ]) {
      if (part) current = path.join(current, part);
      let stat;
      try {
        stat = fs.lstatSync(current);
      } catch (error) {
        if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT")
          return { path: target, missing: true };
        throw error;
      }
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1))
        throw new Error(`Unsafe review file: ${target}`);
    }
    const canonical = fs.realpathSync(target);
    if (!inside(owner, canonical))
      throw new Error("Review file escaped its authorized root");
    const fd = fs.openSync(canonical, "r");
    try {
      const before = fs.fstatSync(fd);
      total += before.size;
      if (
        !before.isFile() ||
        before.nlink > 1 ||
        before.size > 20 * 1024 * 1024 ||
        total > 64 * 1024 * 1024
      )
        throw new Error(
          "Review snapshot requires regular files, at most 20 MiB each and 64 MiB per batch",
        );
      const bytes = fs.readFileSync(fd);
      const after = fs.fstatSync(fd);
      if (
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        bytes.length !== before.size
      )
        throw new Error(`Review file changed while being hashed: ${target}`);
      return {
        path: canonical,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    } finally {
      fs.closeSync(fd);
    }
  });
}
