export type Execution = "host" | "sandbox" | "files";
export type TaskState =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";
export type DeliveryState =
  | "pending"
  | "leased"
  | "admitted"
  | "observed"
  | "cancelled";
export interface Workspace {
  root: string;
  access: "read-only" | "read-write";
  execution: Execution;
  extraReadRoots: string[];
  sandbox?: {
    engine: "podman";
    image: string;
    cpus?: number;
    memoryMb?: number;
    pidsLimit?: number;
    maxSeconds?: number;
  };
}
export interface Member {
  id: string;
  name: string;
  role: string;
  model?: string;
  thinkingLevel: string;
  workspace: Workspace;
  allow: string[];
  sessionId: string;
  sessionFile?: string;
  createdAt: number;
  temporary: boolean;
  revision?: number;
  archivedAt?: number;
  archiveReason?: string;
}
export interface Task {
  id: string;
  missionId: string;
  memberId: string;
  member: string;
  parentId?: string;
  rootId: string;
  attemptOf?: string;
  dependsOn?: string;
  state: TaskState;
  epoch: number;
  phase: "work" | "review";
  inputPath: string;
  resultPath?: string;
  summary?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  timeoutMs: number;
  processState: "not-started" | "running" | "stopped" | "unknown";
  reviewDeliveryIds: string[];
  sessionFile?: string;
  blockedReason?: string;
  archivedAt?: number;
}
export interface Delivery {
  id: string;
  key: string;
  taskId?: string;
  from: string;
  to: string;
  kind:
    | "result"
    | "failure"
    | "decision"
    | "progress"
    | "reminder"
    | "recovery"
    | "continue";
  summary: string;
  artifact?: string;
  state: DeliveryState;
  createdAt: number;
  attempts: number;
  nextAttemptAt: number;
  batchId?: string;
  leaseUntil?: number;
  reason?: string;
  missionId?: string;
  scheduleId?: string;
  scheduleRevision?: number;
}
export interface Mission {
  id: string;
  objective: string;
  criteria: string[];
  status:
    | "active"
    | "paused"
    | "waiting_user"
    | "complete"
    | "stopped"
    | "attention";
  createdAt: number;
  updatedAt: number;
  budgetStartedAt: number;
  turns: number;
  outputTokens: number;
  emptyTurns: number;
  reason?: string;
  evidence?: Array<{ criterion: number; evidence: string }>;
  lastReportAt: number;
  nextContinueAt: number;
  humanPaused: boolean;
  revision?: number;
  archivedAt?: number;
  archiveReason?: string;
}
export interface Schedule {
  id: string;
  title: string;
  prompt: string;
  nextAt: number;
  intervalMs?: number;
  state: "active" | "paused" | "ended";
  createdAt: number;
  updatedAt?: number;
  missionId?: string;
  revision?: number;
  archivedAt?: number;
  archiveReason?: string;
}
export type ArchiveKind = "goal" | "member" | "schedule";
export interface Settings {
  reconnect?: import("./reconnect.ts").ReconnectOptions;
  maxParallel: number;
  taskTimeoutMs: number;
  progressIntervalMs: number;
  maxMissionMs: number;
  maxAutonomousTurns: number;
  maxOutputTokens: number;
  maxWakeAttempts: number;
  retryBaseMs: number;
  defaultExecution: Execution;
  workerExtensions: string[];
  inheritEnv: string[];
  searchProvider: "exa" | "brave" | "searxng";
  searchUrl?: string;
}
export const DEFAULT_SETTINGS: Settings = {
  maxParallel: 4,
  taskTimeoutMs: 600_000,
  progressIntervalMs: 3_600_000,
  maxMissionMs: 43_200_000,
  maxAutonomousTurns: 200,
  maxOutputTokens: 2_000_000,
  maxWakeAttempts: 3,
  retryBaseMs: 2000,
  defaultExecution: "host",
  workerExtensions: [],
  inheritEnv: [],
  searchProvider: "exa",
};
export function resolveSettings(raw: Partial<Settings> = {}): Settings {
  const s = { ...DEFAULT_SETTINGS, ...raw };
  for (const [key, min, max] of [
    ["maxParallel", 1, 16],
    ["taskTimeoutMs", 1000, 3_600_000],
    ["progressIntervalMs", 1000, 86_400_000],
    ["maxMissionMs", 60_000, 604_800_000],
    ["maxAutonomousTurns", 1, 10000],
    ["maxOutputTokens", 100, 100_000_000],
    ["maxWakeAttempts", 1, 10],
    ["retryBaseMs", 100, 300_000],
  ] as const) {
    if (!Number.isSafeInteger(s[key]) || s[key] < min || s[key] > max)
      throw new Error(`Invalid Mission Control setting: ${key}`);
  }
  if (!["host", "sandbox", "files"].includes(s.defaultExecution))
    throw new Error("Invalid defaultExecution");
  if (!["exa", "brave", "searxng"].includes(s.searchProvider))
    throw new Error("Invalid searchProvider");
  if (
    !Array.isArray(s.workerExtensions) ||
    s.workerExtensions.some((x) => typeof x !== "string") ||
    !Array.isArray(s.inheritEnv) ||
    s.inheritEnv.some((x) => !/^\w+$/.test(x))
  )
    throw new Error("Invalid worker environment/extensions settings");
  return s;
}
export const terminal = (t: Task) =>
  ["completed", "failed", "cancelled", "interrupted"].includes(t.state);
export interface WorkerOutcome {
  ok: boolean;
  text: string;
  error?: string;
  outputTokens?: number;
  sessionFile?: string;
  processState: "stopped" | "unknown";
  cleanSettlement?: boolean;
}
export interface WorkerEvent {
  type: string;
  text?: string;
  tool?: string;
  timestamp?: number;
  sessionFile?: string;
  preview?: PublicActivity;
  clearPreview?: string;
}
export interface PublicActivity {
  id: string;
  kind: "assistant" | "tool";
  title: string;
  text: string;
  at: number;
  timestamp?: number;
  startedAt?: number;
}
export interface Assignment {
  member: Member;
  task: Task;
  prompt: string;
  directory: string;
  bridgeUrl: string;
  token: string;
  settings: Settings;
}
export interface WorkerHandle {
  result: Promise<WorkerOutcome>;
  stop(): Promise<void>;
  deliver?(message: string): Promise<void>;
}
export type WorkerFactory = (
  assignment: Assignment,
  signal: AbortSignal,
  onEvent: (event: WorkerEvent) => void,
) => Promise<WorkerHandle>;
export interface Wake {
  batchId: string;
  generation: number;
  deliveryIds: string[];
  content: string;
}
