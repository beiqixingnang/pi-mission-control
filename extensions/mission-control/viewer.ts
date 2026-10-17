import fs from "node:fs/promises";
import type {
  Theme,
  ThemeBg,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
  Markdown,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type MarkdownTheme,
} from "@earendil-works/pi-tui";
import type { MissionKernel } from "../../runtime/kernel.ts";
import type { Task, PublicActivity } from "../../runtime/types.ts";
import { cleanText, textOf } from "../../runtime/public.ts";
import {
  memberSessionFiles,
  transcriptPage,
  type TranscriptRecord,
} from "../../runtime/transcript.ts";
import { stateNames } from "./ui.ts";
import { panelLine } from "./presentation.ts";
import {
  messageTime,
  readDuration,
  formatTime,
  formatDuration,
} from "../../runtime/time.ts";

interface Row {
  id: string;
  memberId: string;
  task?: Task;
  text: string;
  children: boolean;
}
type ItemKind =
  | "user"
  | "assistant"
  | "tool-call"
  | "tool-result"
  | "tool-pending"
  | "error"
  | "activity";
interface Item {
  id: string;
  title: string;
  body: string;
  kind: ItemKind;
  displayBody?: string;
  language?: string;
  outcome?: "pending" | "success" | "error";
  timestamp?: number;
  durationMs?: number;
  startedAt?: number;
}
type ViewTheme = Partial<
  Pick<Theme, "fg" | "bg" | "bold" | "italic" | "strikethrough" | "underline">
>;
interface ViewerOptions {
  pollMs?: number;
  height?: () => number;
  theme?: ViewTheme;
  editMessage?: (memberName: string) => Promise<string | undefined>;
  copyMessage?: (text: string) => Promise<void>;
  leadSessionFile?: () => string | undefined;
  leadPreviews?: () => PublicActivity[];
}

function boundedRecords(records: TranscriptRecord[], newest = false) {
  const kept: TranscriptRecord[] = [];
  let bytes = 0;
  for (const record of newest ? [...records].reverse() : records) {
    bytes += Buffer.byteLength(JSON.stringify(record.entry));
    if (kept.length && (bytes > 2 * 1024 * 1024 || kept.length >= 400)) break;
    kept.push(record);
  }
  return newest ? kept.reverse() : kept;
}
function color(theme: ViewTheme | undefined, name: ThemeColor, text: string) {
  return theme?.fg?.(name, text) ?? text;
}
function bold(theme: ViewTheme | undefined, text: string) {
  return theme?.bold?.(text) ?? text;
}
function markdownTheme(theme?: ViewTheme): MarkdownTheme {
  return {
    heading: (text) => bold(theme, color(theme, "mdHeading", text)),
    link: (text) => color(theme, "mdLink", text),
    linkUrl: (text) => color(theme, "mdLinkUrl", text),
    code: (text) => color(theme, "mdCode", text),
    codeBlock: (text) => color(theme, "mdCodeBlock", text),
    codeBlockBorder: (text) => color(theme, "mdCodeBlockBorder", text),
    quote: (text) => color(theme, "mdQuote", text),
    quoteBorder: (text) => color(theme, "mdQuoteBorder", text),
    hr: (text) => color(theme, "mdHr", text),
    listBullet: (text) => color(theme, "mdListBullet", text),
    bold: (text) => bold(theme, text),
    italic: (text) => theme?.italic?.(text) ?? text,
    strikethrough: (text) => theme?.strikethrough?.(text) ?? text,
    underline: (text) => theme?.underline?.(text) ?? text,
    codeBlockIndent: "  ",
    highlightCode: (code, language) =>
      code
        .split("\n")
        .map((line) =>
          color(
            theme,
            language === "diff" && line.startsWith("+")
              ? "toolDiffAdded"
              : language === "diff" && line.startsWith("-")
                ? "toolDiffRemoved"
                : "mdCodeBlock",
            line,
          ),
        ),
  };
}

export function teamRows(
  s: ReturnType<MissionKernel["snapshot"]>,
  folded = new Set<string>(),
): Row[] {
  const tasks = s.tasks.slice(0, 200),
    members = new Map(s.members.map((m) => [m.id, m]));
  const ids = new Set(tasks.map((t) => t.id)),
    rows: Row[] = [];
  const visit = (task: Task, depth: number) => {
    if (depth > 30 || rows.some((r) => r.id === task.id)) return;
    const children = tasks
      .filter((t) => t.parentId === task.id)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    const member = members.get(task.memberId);
    rows.push({
      id: task.id,
      memberId: task.memberId,
      task,
      children: Boolean(children.length),
      text: `${"  ".repeat(depth)}${children.length ? (folded.has(task.id) ? "▸" : "▾") : "·"} ${task.member} · ${stateNames[task.state] ?? task.state}${task.phase === "review" ? " · 复核" : ""}${task.blockedReason ? " · " + cleanText(task.blockedReason, 80) : ""} [${member?.workspace.execution ?? "?"}]`,
    });
    if (!folded.has(task.id))
      for (const child of children) visit(child, depth + 1);
  };
  for (const task of tasks
    .filter((t) => !t.parentId || !ids.has(t.parentId))
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)))
    visit(task, 0);
  for (const member of s.members)
    if (!tasks.some((t) => t.memberId === member.id))
      rows.push({
        id: member.id,
        memberId: member.id,
        children: false,
        text: `· ${member.name} · 待命 [${member.workspace.execution}]`,
      });
  return rows;
}

export function conversationItems(
  records: TranscriptRecord[],
  assistantLabel = "成员回复",
): Item[] {
  const results = new Map<
    string,
    { outcome: "error" | "success"; timestamp?: number; durationMs?: number }
  >();
  for (const { entry } of records)
    if (entry.role === "toolResult" && typeof entry.toolCallId === "string")
      results.set(entry.toolCallId, {
        outcome: entry.isError ? "error" : "success",
        timestamp: messageTime(entry),
        durationMs: readDuration(entry.durationMs),
      });
  return records.flatMap(({ offset, entry: e }) => {
    const prefix = String(offset);
    if (e.type === "compaction")
      return [
        {
          id: prefix,
          title: "压缩摘要",
          body: e.summary ?? "",
          kind: "activity" as const,
          timestamp: messageTime(e),
        },
      ];
    const content = e.content,
      body = typeof content === "string" ? content : textOf({ content });
    const items: Item[] = [];
    if (body) {
      const kind: ItemKind =
        e.role === "user"
          ? "user"
          : e.role === "toolResult"
            ? e.isError
              ? "error"
              : "tool-result"
            : e.role === "assistant"
              ? "assistant"
              : "activity";
      const title =
        kind === "user"
          ? "用户任务"
          : kind === "assistant"
            ? assistantLabel
            : kind === "error"
              ? `工具错误 · ${e.toolName ?? "tool"}`
              : kind === "tool-result"
                ? `工具返回 · ${e.toolName ?? "tool"}`
                : "公开事件";
      items.push({
        id: `${prefix}:text`,
        title,
        body,
        kind,
        timestamp: messageTime(e),
        durationMs: readDuration(e.durationMs),
      });
    }
    if (Array.isArray(content))
      for (const [index, block] of content.entries())
        if (block.type === "toolCall") {
          const result = results.get(block.id);
          const args = block.arguments as Record<string, unknown> | undefined;
          const command =
            typeof args?.command === "string" ? args.command : undefined;
          const file = typeof args?.path === "string" ? args.path : undefined;
          const edit =
            block.name === "edit" &&
            typeof args?.oldText === "string" &&
            typeof args?.newText === "string";
          items.push({
            id: `${prefix}:call:${index}`,
            title: command
              ? `执行命令 · ${block.name}`
              : file && ["edit", "write"].includes(block.name)
                ? `${block.name === "edit" ? "编辑文件" : "写入文件"} · ${file}`
                : `工具调用 · ${block.name}`,
            body: JSON.stringify(block.arguments ?? {}, null, 2),
            kind: "tool-call",
            displayBody:
              command ??
              (edit
                ? `${file ?? ""}\n${String(args!.oldText)
                    .split("\n")
                    .map((line) => "- " + line)
                    .join("\n")}\n${String(args!.newText)
                    .split("\n")
                    .map((line) => "+ " + line)
                    .join("\n")}`
                : undefined),
            language: command
              ? block.name === "powershell"
                ? "powershell"
                : "bash"
              : edit
                ? "diff"
                : "json",
            outcome: result?.outcome ?? "pending",
            timestamp:
              result?.timestamp !== undefined && result.durationMs !== undefined
                ? result.timestamp - result.durationMs
                : messageTime(e),
            durationMs: result?.durationMs,
          });
        }
    return items;
  });
}

function itemMarkdown(item: Item, body: string) {
  if (item.kind === "user")
    return body
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
  return body;
}

/** Full-screen team workbench. It never uses a permanent side panel. */
export class MissionPanel {
  view: "team" | "conversation" = "team";
  scope: "member" | "lead" = "member";
  tab = 0;
  following = true;
  selected = 0;
  memberId?: string;
  taskId?: string;
  file?: string;
  files: string[] = [];
  records: TranscriptRecord[] = [];
  before = 0;
  unread = false;
  error = "";
  renderError?: string;
  private skipped = false;
  private size = -1;
  private stamp = "";
  private busy = false;
  private disposed = false;
  private revision = 0;
  private autoSession = true;
  private timer?: ReturnType<typeof setInterval>;
  private expanded = new Set<string>();
  private folded = new Set<string>();
  private selectedRow?: string;
  private selectedItem?: string;
  private scroll = 0;
  private rowScroll = 0;
  private pageScroll = 0;
  private height = 20;
  private itemStarts: number[] = [];
  private theme?: ViewTheme;
  private editMessage?: (memberName: string) => Promise<string | undefined>;
  private copyMessage?: (text: string) => Promise<void>;
  private leadSessionFile?: () => string | undefined;
  private leadPreviews?: () => PublicActivity[];

  constructor(
    private kernel: MissionKernel,
    private redraw: () => void,
    private done: () => void,
    options: ViewerOptions = {},
  ) {
    this.theme = options.theme;
    this.editMessage = options.editMessage;
    this.copyMessage = options.copyMessage;
    this.leadSessionFile = options.leadSessionFile;
    this.leadPreviews = options.leadPreviews;
    this.getHeight = options.height ?? (() => process.stdout.rows ?? 24);
    if (options.pollMs !== 0) {
      this.timer = setInterval(
        () => void this.refresh(),
        options.pollMs ?? 500,
      );
      this.timer.unref?.();
    }
  }
  private getHeight: () => number;
  dispose() {
    this.disposed = true;
    this.revision++;
    if (this.timer) clearInterval(this.timer);
  }

  async openMember(id: string, taskId?: string) {
    const member = this.kernel.store.member(id);
    if (!member) throw new Error(`Unknown member: ${id}`);
    this.scope = "member";
    this.memberId = member.id;
    this.taskId = taskId;
    this.resetConversation();
    await this.refresh();
  }
  async openLead() {
    this.scope = "lead";
    this.memberId = undefined;
    this.taskId = undefined;
    this.resetConversation();
    await this.refresh();
  }
  private resetConversation() {
    this.revision++;
    this.view = "conversation";
    this.file = undefined;
    this.files = [];
    this.records = [];
    this.before = 0;
    this.size = -1;
    this.stamp = "";
    this.following = true;
    this.unread = false;
    this.scroll = 0;
    this.autoSession = true;
    this.error = "";
    this.selectedItem = undefined;
  }
  async refresh() {
    if (this.disposed || this.busy) return;
    if (
      this.view !== "conversation" ||
      (this.scope === "member" && !this.memberId)
    ) {
      this.redraw();
      return;
    }
    const revision = this.revision,
      memberId = this.memberId;
    this.busy = true;
    try {
      const leadFile =
        this.scope === "lead" ? this.leadSessionFile?.() : undefined;
      const files =
        this.scope === "lead"
          ? leadFile
            ? [leadFile]
            : []
          : await memberSessionFiles(this.kernel.store.directory, memberId!);
      if (this.disposed || revision !== this.revision) return;
      this.files = files;
      const preferred =
        this.scope === "lead"
          ? leadFile
          : ((this.taskId
              ? this.kernel.store.task(this.taskId)?.sessionFile
              : undefined) ?? this.kernel.store.member(memberId!)?.sessionFile);
      const next =
        this.autoSession &&
        (this.following || !this.file) &&
        preferred &&
        files.includes(preferred)
          ? preferred
          : this.file && files.includes(this.file)
            ? this.file
            : files[0];
      if (next !== this.file) {
        this.file = next;
        this.size = -1;
        this.records = [];
        this.before = 0;
        this.stamp = "";
      }
      if (!this.file) return;
      const stat = await fs.stat(this.file),
        stamp = `${stat.size}:${stat.mtimeMs}`;
      if (this.disposed || revision !== this.revision) return;
      if (stamp !== this.stamp) {
        this.unread = this.size >= 0;
        if (this.following || this.size < 0) {
          const page = await transcriptPage(this.file);
          if (this.disposed || revision !== this.revision) return;
          this.records = boundedRecords(page.records, true);
          this.before =
            this.records.length < page.records.length
              ? (this.records[0]?.offset ?? page.before)
              : page.before;
          this.skipped = page.skipped;
          this.size = stat.size;
          this.stamp = stamp;
          this.unread = false;
          this.selectedItem = undefined;
        }
      }
      this.error = "";
    } catch (error) {
      if (!this.disposed && revision === this.revision)
        this.error = cleanText(String(error), 250);
    } finally {
      this.busy = false;
      if (!this.disposed) this.redraw();
    }
  }
  async older() {
    if (this.disposed || this.busy || !this.file || !this.before) return;
    const revision = this.revision;
    this.following = false;
    this.busy = true;
    try {
      const page = await transcriptPage(this.file, this.before);
      if (this.disposed || revision !== this.revision) return;
      this.records = boundedRecords([...page.records, ...this.records]);
      this.before = page.before;
      this.skipped ||= page.skipped;
      this.selectedItem = conversationItems(this.records)[0]?.id;
      this.scroll = 0;
    } catch (error) {
      this.error = cleanText(String(error), 250);
    } finally {
      this.busy = false;
      if (!this.disposed) this.redraw();
    }
  }
  private items() {
    const items = conversationItems(
      this.records,
      this.scope === "lead" ? "主会话回复" : "成员回复",
    );
    const append = (p: PublicActivity) =>
      items.push({
        id: p.id,
        title:
          p.kind === "assistant" && this.scope === "lead"
            ? "主会话正在回复"
            : p.title,
        body: p.text,
        kind: p.kind === "tool" ? "tool-pending" : "assistant",
        timestamp: p.timestamp,
        startedAt: p.startedAt,
      });
    if (this.scope === "lead") {
      if (!this.file || this.file === this.leadSessionFile?.())
        for (const p of this.leadPreviews?.() ?? []) append(p);
      return items;
    }
    const active = this.kernel.store
      .tasks(true)
      .find((t) => t.memberId === this.memberId && t.state === "running");
    if (
      !this.file ||
      (active && (!active.sessionFile || active.sessionFile === this.file))
    )
      for (const p of this.kernel.publicActivity(this.memberId ?? ""))
        append(p);
    return items;
  }
  private statusLabel(memberId: string) {
    const tasks = this.kernel.store
      .tasks()
      .filter((t) => t.memberId === memberId)
      .sort((a, b) => b.createdAt - a.createdAt);
    const task =
      tasks.find((t) => ["queued", "running", "waiting"].includes(t.state)) ??
      tasks[0];
    return task ? (stateNames[task.state] ?? task.state) : "待命";
  }

  render(width: number) {
    const columns = Math.max(1, Math.floor(width) || 1);
    try {
      const lines = this.renderContent(columns);
      this.renderError = undefined;
      return lines;
    } catch (error) {
      // Pi calls custom renderers outside the slash-command try/catch.
      // A broken theme or message must not terminate the host or its workers.
      this.renderError = cleanText(
        error instanceof Error ? error.message : String(error),
        300,
      );
      return [
        "成员视图渲染失败；可返回主会话，后台任务不受本面板控制。",
        this.renderError,
        "Esc 返回团队 · 再按 Esc 退出工作台",
      ]
        .flatMap((line) => wrapTextWithAnsi(line, columns))
        .slice(0, Math.max(3, this.height));
    }
  }

  private renderContent(width: number) {
    const s = this.kernel.snapshot();
    this.height = Math.max(3, this.getHeight() - 5);
    let lines: string[];
    if (this.view === "team") {
      const counts = {
          running: s.tasks.filter((t) => t.state === "running").length,
          waiting: s.tasks.filter((t) => t.state === "waiting").length,
          attention: s.mission?.status === "attention" ? 1 : 0,
        },
        m = s.mission;
      const head = [
        bold(this.theme, color(this.theme, "accent", "AGENTS / TEAM STATUS")),
        `${m ? stateNames[m.status] : "就绪"} · 成员 ${s.members.length} · 执行中 ${counts.running} · 等待 ${counts.waiting}${counts.attention ? ` · 需要处理 ${counts.attention}` : ""}`,
        m
          ? `目标：${cleanText(m.objective.replace(/\s+/g, " "), Math.max(20, width - 8))}`
          : "派工后自动维护；Enter 进入成员对话",
        `${["团队 / 任务", "目标 / 验收", "定时提醒"].map((t, i) => (i === this.tab ? `[${t}]` : t)).join("  ")}`,
      ];
      if (this.tab === 0) {
        const rows = teamRows(s, this.folded);
        if (this.selectedRow && rows.some((r) => r.id === this.selectedRow))
          this.selected = rows.findIndex((r) => r.id === this.selectedRow);
        this.selected = Math.min(this.selected, Math.max(0, rows.length - 1));
        this.selectedRow = rows[this.selected]?.id;
        const count = Math.max(1, this.height - 6);
        this.rowScroll = Math.max(0, Math.min(this.rowScroll, this.selected));
        if (this.selected >= this.rowScroll + count)
          this.rowScroll = this.selected - count + 1;
        lines = [
          ...head,
          ...rows.slice(this.rowScroll, this.rowScroll + count).map((r, i) => {
            const live = r.task?.state === "running",
              activity = this.kernel.store.get<{ tool?: string }>(
                `activity:${r.memberId}`,
              ),
              marker = live
                ? "●"
                : r.task?.state === "failed"
                  ? "!"
                  : r.task?.state === "completed"
                    ? "✓"
                    : "○";
            return `${this.rowScroll + i === this.selected ? "▶" : " "} ${marker} ${r.text}${activity?.tool ? ` · ${activity.tool}` : ""}`;
          }),
        ];
        if (!rows.length) lines.push("尚无成员；模型派工后会在这里显示。");
        lines.push(
          "",
          "↑↓ 选择 · Enter 对话 · t 主对话时间线 · ←→ 折叠 · Tab 切页 · Esc 返回",
        );
      } else {
        const details =
          this.tab === 1
            ? m
              ? [
                  m.objective,
                  `状态：${stateNames[m.status]}${m.reason ? " · " + m.reason : ""}`,
                  ...m.criteria.map(
                    (c, i) =>
                      `${i + 1}. ${c}\n   证据：${m.evidence?.find((e) => e.criterion === i + 1)?.evidence ?? "尚未提交"}`,
                  ),
                  `自动接续 ${m.turns}/${this.kernel.settings.maxAutonomousTurns}`,
                ]
              : ["尚未创建目标"]
            : s.schedules.length
              ? s.schedules.map(
                  (r) =>
                    `${r.title} · ${r.state}\n${new Date(r.nextAt).toISOString()}${r.intervalMs ? ` · 每${r.intervalMs / 1000}秒` : ""}\n${r.prompt}`,
                )
              : ["暂无定时提醒"];
        const wrapped = details.flatMap((v) =>
          wrapTextWithAnsi(cleanText(v, 16000), Math.max(1, width)),
        );
        this.pageScroll = Math.min(
          this.pageScroll,
          Math.max(0, wrapped.length - this.height + 5),
        );
        lines = [
          ...head,
          ...wrapped.slice(
            this.pageScroll,
            this.pageScroll + Math.max(1, this.height - 5),
          ),
          "↑↓ 滚动 · Tab 切页 · Esc 返回",
        ];
      }
    } else {
      const member = this.kernel.store.member(this.memberId ?? ""),
        items = this.items();
      let index = this.following
        ? items.length - 1
        : Math.max(
            0,
            items.findIndex((i) => i.id === this.selectedItem),
          );
      index = Math.max(0, index);
      this.selectedItem = items[index]?.id;
      const body: string[] = [],
        starts: number[] = [],
        mdTheme = markdownTheme(this.theme);
      for (const [i, item] of items.entries()) {
        starts.push(body.length);
        const background: ThemeBg | undefined =
          item.kind === "assistant"
            ? undefined
            : item.kind === "user"
              ? "userMessageBg"
              : item.kind === "error" || item.outcome === "error"
                ? "toolErrorBg"
                : item.kind === "tool-result" || item.outcome === "success"
                  ? "toolSuccessBg"
                  : item.kind === "tool-call" || item.kind === "tool-pending"
                    ? "toolPendingBg"
                    : "customMessageBg";
        const card: string[] = [];
        const selected = i === index,
          labelColor =
            item.kind === "error"
              ? "error"
              : item.kind === "tool-call" || item.kind === "tool-result"
                ? "warning"
                : item.kind === "user"
                  ? "accent"
                  : "muted";
        const timing = truncateToWidth(
          `${formatTime(item.timestamp)}${item.durationMs !== undefined ? ` · 耗时 ${formatDuration(item.durationMs)}` : item.startedAt !== undefined ? ` · 已运行 ${formatDuration(Date.now() - item.startedAt)}` : ""}`,
          Math.max(1, width - 4),
        );
        const titleWidth = Math.max(0, width - visibleWidth(timing) - 4);
        const title = truncateToWidth(
          `${item.title}${this.expanded.has(item.id) ? "  [展开]" : ""}`,
          titleWidth,
        );
        card.push(
          `${selected ? "▶" : " "} ${color(this.theme, labelColor, title)}  ${color(this.theme, "dim", timing)}`,
        );
        const expanded = this.expanded.has(item.id),
          displayBody = item.displayBody ?? item.body,
          excerpt = expanded ? displayBody : displayBody.slice(0, 800);
        const action = [
          "tool-call",
          "tool-result",
          "tool-pending",
          "error",
        ].includes(item.kind);
        const rendered = action
          ? cleanText(excerpt, 32000)
              .replace(/\t/g, "    ")
              .split("\n")
              .flatMap((line) =>
                wrapTextWithAnsi(
                  color(
                    this.theme,
                    item.language === "diff" && line.startsWith("+")
                      ? "toolDiffAdded"
                      : item.language === "diff" && line.startsWith("-")
                        ? "toolDiffRemoved"
                        : "toolOutput",
                    line,
                  ),
                  Math.max(1, width - 4),
                ).map((wrapped) => "  " + wrapped),
              )
          : new Markdown(itemMarkdown(item, excerpt), 2, 0, mdTheme).render(
              Math.max(1, width - 2),
            );
        const visible = expanded
          ? rendered
          : rendered.slice(
              0,
              item.kind === "tool-call" || item.kind === "tool-result" ? 3 : 12,
            );
        card.push(...visible.map((line) => `  ${line}`));
        if (
          !expanded &&
          (displayBody.length > excerpt.length ||
            visible.length < rendered.length)
        )
          card.push(color(this.theme, "dim", "  … Enter 展开"));
        body.push(
          ...card.map((line) => panelLine(line, width, background, this.theme)),
        );
        body.push("");
      }
      if (!items.length)
        body.push(
          this.busy
            ? "正在读取公开记录…"
            : this.scope === "lead"
              ? "等待主会话公开记录；临时会话可能没有磁盘日志。"
              : "等待公开消息；成员尚未启动或尚未写入会话。",
          "打开此页面不会启动模型或改变任务。",
        );
      if (this.error)
        body.push(color(this.theme, "error", "读取提示：" + this.error));
      const count = Math.max(1, this.height - 5);
      if (this.following) this.scroll = Math.max(0, body.length - count);
      this.scroll = Math.min(this.scroll, Math.max(0, body.length - count));
      this.itemStarts = starts;
      lines = [
        bold(
          this.theme,
          color(
            this.theme,
            "accent",
            this.scope === "lead"
              ? "主会话 · 公开时间线"
              : `${member?.name ?? "成员"} · ${member?.role ?? ""}`,
          ),
        ),
        `${this.scope === "lead" ? (this.file ? "磁盘公开记录，非模型上下文" : "实时公开预览，尚无磁盘记录") : this.statusLabel(this.memberId ?? "")} · ${this.following ? "跟随最新" : "暂停跟随"}${this.unread ? " · 有新记录" : ""}${this.scope === "lead" ? "" : ` · 会话 ${this.file ? this.files.indexOf(this.file) + 1 : 0}/${this.files.length}`}`,
        ...body.slice(this.scroll, this.scroll + count),
        this.scope === "lead"
          ? "↑↓ 选择 · Enter 展开 · m 返回输入 · c 复制 · f 跟随 · Home/PgUp 更早 · End 最新"
          : "↑↓ 选择 · Enter 展开 · m 发消息 · c 复制 · f 跟随 · Home/PgUp 更早 · End 最新 · [ ] 历史",
        "Esc 返回团队 · q 退出工作台 · 当前页面不使用右侧分栏",
      ];
    }
    return lines
      .slice(0, this.height)
      .map((line) => truncateToWidth(line, Math.max(1, width)));
  }

  private async copySelected() {
    const item = this.items().find((i) => i.id === this.selectedItem);
    if (!item) return;
    if (!this.copyMessage) {
      this.error = "当前运行模式没有可用的剪贴板接口";
      this.redraw();
      return;
    }
    try {
      await this.copyMessage(`[${item.title}]\n${item.body}`);
      this.error = "已复制当前消息";
    } catch (error) {
      this.error = `复制失败：${String(error)}`;
    }
    this.redraw();
  }
  private async sendToMember() {
    const member = this.kernel.store.member(this.memberId ?? "");
    if (!member) return;
    if (!this.editMessage) {
      this.error = "当前没有可用的成员输入编辑器";
      this.redraw();
      return;
    }
    const message = await this.editMessage(member.name);
    if (!message?.trim()) return;
    try {
      const result = await this.kernel.messageMember(member.name, message);
      this.error =
        result.mode === "steer"
          ? "消息已发送到当前回合"
          : "消息已创建为新成员回合";
    } catch (error) {
      this.error = String(error);
    }
    this.redraw();
  }

  handleInput(data: string) {
    if (this.disposed) return;
    if (
      data === "q" ||
      (data === "m" && this.view === "conversation" && this.scope === "lead")
    ) {
      this.dispose();
      this.done();
    } else if (matchesKey(data, "escape")) {
      if (this.view === "conversation") {
        this.revision++;
        this.view = "team";
        this.selectedItem = undefined;
      } else {
        this.dispose();
        this.done();
      }
    } else if (this.view === "team") {
      if (data === "t") {
        void this.openLead();
      } else if (matchesKey(data, "tab")) {
        this.tab = (this.tab + 1) % 3;
        this.pageScroll = 0;
      } else if (this.tab !== 0) {
        if (matchesKey(data, "down")) this.pageScroll++;
        if (matchesKey(data, "up"))
          this.pageScroll = Math.max(0, this.pageScroll - 1);
        if (matchesKey(data, "pageDown")) this.pageScroll += 10;
        if (matchesKey(data, "pageUp"))
          this.pageScroll = Math.max(0, this.pageScroll - 10);
      } else {
        const rows = teamRows(this.kernel.snapshot(), this.folded);
        let index = this.selectedRow
          ? rows.findIndex((r) => r.id === this.selectedRow)
          : this.selected;
        index = Math.max(0, index);
        if (matchesKey(data, "down"))
          index = Math.min(rows.length - 1, index + 1);
        if (matchesKey(data, "up")) index = Math.max(0, index - 1);
        if (matchesKey(data, "pageDown"))
          index = Math.min(rows.length - 1, index + 10);
        if (matchesKey(data, "pageUp")) index = Math.max(0, index - 10);
        const row = rows[index];
        this.selected = Math.max(0, index);
        this.selectedRow = row?.id;
        if (row && matchesKey(data, "left")) this.folded.add(row.id);
        if (row && matchesKey(data, "right")) this.folded.delete(row.id);
        if (row && matchesKey(data, "enter"))
          void this.openMember(row.memberId, row.task?.id);
      }
    } else {
      const items = this.items();
      let index = Math.max(
        0,
        items.findIndex((i) => i.id === this.selectedItem),
      );
      if (matchesKey(data, "up") || matchesKey(data, "down")) {
        this.following = false;
        index = Math.max(
          0,
          Math.min(items.length - 1, index + (matchesKey(data, "up") ? -1 : 1)),
        );
        this.selectedItem = items[index]?.id;
        this.scroll = this.itemStarts[index] ?? 0;
        if (index === 0 && matchesKey(data, "up")) void this.older();
      } else if (matchesKey(data, "enter")) {
        this.following = false;
        if (this.selectedItem) {
          if (this.expanded.has(this.selectedItem))
            this.expanded.delete(this.selectedItem);
          else this.expanded.add(this.selectedItem);
        }
      } else if (data === "m") void this.sendToMember();
      else if (data === "c") void this.copySelected();
      else if (matchesKey(data, "pageUp")) {
        this.following = false;
        if (this.scroll <= 0) void this.older();
        else
          this.scroll = Math.max(0, this.scroll - Math.max(1, this.height - 5));
      } else if (matchesKey(data, "pageDown")) {
        this.following = false;
        this.scroll += Math.max(1, this.height - 5);
      } else if (matchesKey(data, "home")) {
        this.following = false;
        this.scroll = 0;
        void this.older();
      } else if (matchesKey(data, "end") || data === "f") {
        this.following = data === "f" ? !this.following : true;
        if (this.following) {
          this.stamp = "";
          void this.refresh();
        }
      } else if ((data === "[" || data === "]") && this.files.length) {
        const current = this.files.indexOf(this.file!);
        this.revision++;
        this.autoSession = false;
        this.file =
          this.files[
            (current + (data === "[" ? -1 : 1) + this.files.length) %
              this.files.length
          ];
        this.size = -1;
        this.stamp = "";
        this.following = true;
        this.records = [];
        void this.refresh();
      }
    }
    if (!this.disposed) this.redraw();
  }
}
