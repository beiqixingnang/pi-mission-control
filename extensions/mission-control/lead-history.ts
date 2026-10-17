import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PublicActivity } from "../../runtime/types.ts";
import { WorkerPublicStream } from "../../runtime/rpc-worker.ts";

/** Public live messages for our own timeline; does not replace native renderers. */
export class LeadHistory {
  private stream = new WorkerPublicStream();
  private current = new Map<string, PublicActivity>();
  clear() {
    this.stream = new WorkerPublicStream();
    this.current.clear();
  }
  accept(event: unknown) {
    const projected = this.stream.accept(event);
    if (!projected) return false;
    if (projected.clearPreview) this.current.delete(projected.clearPreview);
    if (projected.preview) {
      this.current.set(projected.preview.id, projected.preview);
      if (this.current.size > 16)
        this.current.delete(this.current.keys().next().value!);
    }
    return true;
  }
  previews(): PublicActivity[] {
    return [...this.current.values()];
  }
}

export function installLeadHistory(pi: ExtensionAPI, changed: () => void) {
  const history = new LeadHistory();
  pi.on("session_start", () => history.clear());
  pi.on("session_shutdown", () => history.clear());
  const observe = (event: unknown) => {
    if (history.accept(event)) changed();
  };
  pi.on("message_start", observe);
  pi.on("message_update", observe);
  pi.on("message_end", observe);
  pi.on("tool_execution_start", observe);
  pi.on("tool_execution_update", observe);
  pi.on("tool_execution_end", observe);
  return history;
}
