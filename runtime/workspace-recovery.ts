import fs from "node:fs";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Store } from "./store.ts";
import { SessionCatalog, type RecoverySession } from "./session-catalog.ts";
import {
  prepareRelocation,
  type Relocation,
  type RelocationSource,
} from "./relocation.ts";

export interface PreparedRecovery {
  relocation: Relocation;
  release(): void;
}

export async function prepareWorkspaceRecovery(
  info: RecoverySession,
  ctx: ExtensionContext,
  beforePrepare?: () => Promise<void>,
): Promise<PreparedRecovery> {
  const catalog = new SessionCatalog();
  let fresh: RecoverySession | undefined;
  try {
    if (catalog.latest(info.file) !== info.file)
      throw new Error(
        "This conversation was already restored elsewhere; reopen the picker",
      );
    fresh = await catalog.inspect(info.file, true);
  } finally {
    catalog.close();
  }
  if (!fresh || fresh.id !== info.id || fresh.cwd !== info.cwd)
    throw new Error("Session metadata changed; reopen the recovery picker");
  const selected = fresh;
  if (fresh.id === ctx.sessionManager.getSessionId())
    throw new Error("This is already the current conversation");
  const target = fs.realpathSync.native(ctx.cwd),
    source = path.resolve(fresh.cwd);
  if (source === path.parse(source).root || source !== fresh.cwd)
    throw new Error(
      "The stored workspace is not a normalized project directory",
    );
  const store = new Store(
    path.join(getAgentDir(), "mission-control/v2", fresh.id),
  );
  try {
    // Restore uncertain orphan executions under the relocation hold. They must
    // be reconciled in the new workspace; copying never attests they stopped.
    const manager: RelocationSource = {
      getSessionFile: () => selected.file,
      getSessionId: () => selected.id,
      getSessionDir: () => path.dirname(selected.file),
      getLeafId: () => null,
      getHeader: () =>
        selected.header as ReturnType<RelocationSource["getHeader"]>,
      getEntries: () => [],
    };
    await beforePrepare?.();
    const relocation = await prepareRelocation(
      { action: "restore", source, target },
      { sessionManager: manager },
      { store },
      ctx.sessionManager.getSessionDir(),
    );
    return { relocation, release: () => store.close() };
  } catch (error) {
    store.close();
    throw error;
  }
}
