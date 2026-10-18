import { terminal, type Member, type Task } from "./types.ts";

/** One current task per live member; old identities never create roster entries. */
export function memberTask(member: Member, tasks: Task[]): Task | undefined {
  const own = tasks
    .filter((t) => t.memberId === member.id)
    .sort(
      (a, b) =>
        b.createdAt - a.createdAt ||
        b.updatedAt - a.updatedAt ||
        a.id.localeCompare(b.id),
    );
  return (
    own.find((t) => t.state === "running") ??
    own.find((t) => !terminal(t)) ??
    own[0]
  );
}
