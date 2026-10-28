import {
  matchesKey,
  wrapTextWithAnsi,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import type { MissionKernel } from "../../runtime/kernel.ts";
import type { GoalNode } from "../../runtime/types.ts";
import { cleanText } from "../../runtime/public.ts";
import { panelLine, type UiTheme } from "./presentation.ts";
import { stateNames, missionState } from "./ui.ts";

export const goalStateNames: Record<string, string> = {
  planned: "待推进",
  active: "进行中",
  review: "待验收",
  blocked: "阻塞",
  accepted: "已验收",
  cancelled: "已取消",
  skipped: "已跳过",
};

/** Read the same SQLite ledger as model tools; never maintains a second progress list. */
export class GoalPanel {
  selectedId?: string;
  detailId?: string;
  error = "";
  expanded = new Set<string>();
  private disposed = false;
  private scroll = 0;
  private rows: GoalNode[] = [];
  private kernel: MissionKernel;
  private redraw: () => void;
  private done: () => void;
  private theme?: UiTheme;
  private height: () => number;
  constructor(
    kernel: MissionKernel,
    redraw: () => void,
    done: () => void,
    options: { theme?: UiTheme; height?: () => number } = {},
  ) {
    this.kernel = kernel;
    this.redraw = redraw;
    this.done = done;
    this.theme = options.theme;
    this.height =
      options.height ?? (() => Math.max(6, (process.stdout.rows ?? 30) - 4));
    this.selectedId = kernel.store.mission()?.id;
    for (const goal of kernel.store.goals(this.selectedId))
      if (goal.depth <= 2) this.expanded.add(goal.id);
  }
  dispose() {
    this.disposed = true;
  }
  private tree() {
    const nodes = this.kernel.store.goals(),
      result: GoalNode[] = [];
    const children = new Map<string | undefined, GoalNode[]>();
    for (const goal of nodes)
      children.set(goal.parentId, [
        ...(children.get(goal.parentId) ?? []),
        goal,
      ]);
    const visit = (parentId?: string) => {
      for (const goal of (children.get(parentId) ?? []).sort(
        (a, b) => a.order - b.order || a.createdAt - b.createdAt,
      )) {
        result.push(goal);
        if (this.expanded.has(goal.id)) visit(goal.id);
      }
    };
    visit();
    this.rows = result;
    if (!result.some((n) => n.id === this.selectedId))
      this.selectedId = result[0]?.id;
    return { nodes, rows: result };
  }
  render(width: number) {
    const columns = Math.max(1, Math.floor(width) || 1),
      height = Math.max(4, this.height());
    try {
      const current = this.kernel.store.mission(),
        workspaceHeld = Boolean(this.kernel.store.get("relocationHold")),
        progress = this.kernel.goals.summary(),
        { nodes, rows } = this.tree();
      const heading = [
        "目标 / GOALS",
        `当前：${workspaceHeld ? "迁移后待恢复 · 请手动执行 /mission resume" : current ? `${stateNames[current.status]} · ${current.objective}` : "尚未激活主目标"}`,
        `二级 ${progress.level2.completed}/${progress.level2.total} 已验收 · 三级 ${progress.level3.completed}/${progress.level3.total} 已验收 · 深度上限 ${progress.maxDepth}`,
      ];
      let body: string[], footer: string;
      if (this.detailId) {
        const detail = this.kernel.goals.detail(this.detailId),
          goal = detail.goal;
        const runtime =
          goal.depth === 1
            ? this.kernel.store.savedMission(goal.id)
            : undefined;
        const activity =
          goal.depth === 1
            ? this.kernel.store.get<{ activeMs: number }>(
                `goalActivityClock:${goal.id}`,
              )
            : undefined;
        body = [
          `${goal.objective} · ${goalStateNames[goal.state]}`,
          `ID ${goal.id} · 第${goal.depth}级 · 版本 ${goal.revision}`,
          ...(runtime
            ? [
                `运行状态：${missionState(runtime, undefined, workspaceHeld && goal.id === current?.id)}${goal.id === current?.id ? " · 当前主目标" : " · 未激活"}${runtime.reason ? " · " + runtime.reason : ""}`,
                `累计活动 ${Math.floor((activity?.activeMs ?? 0) / 1000)}秒 · 自动接续 ${runtime.turns}回合 · 主输出 ${runtime.outputTokens} tokens`,
              ]
            : []),
          ...(goal.module ? [`模块：${goal.module}`] : []),
          ...(goal.scope
            ? [
                `范围（${goal.scope.unitKind}）：${goal.scope.items.join("、")}`,
                ...(goal.scope.files?.length
                  ? [`文件：${goal.scope.files.join("、")}`]
                  : []),
              ]
            : []),
          ...(goal.reason ? [`原因：${goal.reason}`] : []),
          ...(goal.nextStep ? [`下一步：${goal.nextStep}`] : []),
          ...(goal.plan
            ? [
                `执行计划 · 版本 ${goal.planRevision ?? 0}：`,
                ...goal.plan
                  .split("\n")
                  .flatMap((line) => line.match(/[\s\S]{1,2000}/gu) ?? [""]),
              ]
            : ["执行计划：未设置（可选）"]),
          ...(goal.planEditors?.length
            ? [
                "计划编辑授权：" +
                  goal.planEditors
                    .map(
                      (entry) =>
                        `${this.kernel.store.member(entry.memberId)?.name ?? entry.memberId}（${entry.mode === "once" ? "一次性" : "长期"}）`,
                    )
                    .join("、"),
              ]
            : []),
          ...detail.blockers.map((b) => `阻塞：${b}`),
          ...(goal.estimateMs
            ? [
                `预计投入：${Math.ceil(goal.estimateMs[0] / 60000)}–${Math.ceil(goal.estimateMs[1] / 60000)}分钟（不等于交付日期）`,
              ]
            : ["预计投入：尚未估算"]),
          "验收标准与当前证据：",
          ...goal.criteria.flatMap((criterion, index) => [
            `${index + 1}. ${criterion}`,
            ...(detail.acceptance?.evidence
              .filter((e) => e.criterion === index + 1)
              .map(
                (e) =>
                  `   [${e.source === "statement" ? "模型陈述" : e.source}] ${e.summary}${e.path ? " · " + e.path : ""}${e.taskId ? " · task " + e.taskId : ""}${e.receiptId ? " · receipt " + e.receiptId : ""}${e.acceptanceId ? " · acceptance " + e.acceptanceId : ""}`,
              ) ?? ["   尚未登记证据"]),
          ]),
          ...(detail.acceptance?.children.map(
            (c) => `引用子目标验收：${c.goalId} → ${c.acceptanceId}`,
          ) ?? []),
          `验收历史 ${detail.history.length} 份（旧版本保留） · 关联任务 ${detail.tasks.length} 项`,
          ...detail.history
            .filter((record) => record.id !== detail.acceptance?.id)
            .slice(-3)
            .reverse()
            .flatMap((record) => [
              `历史验收 · 版本 ${record.revision} · ${new Date(record.at).toISOString()} · ${record.id}`,
              ...record.evidence
                .slice(0, 5)
                .map(
                  (item) =>
                    `   [${item.source === "statement" ? "模型陈述" : item.source}] 标准${item.criterion} ${cleanText(item.summary, 400)}${item.path ? " · " + item.path : ""}`,
                ),
            ]),
          ...detail.tasks
            .slice(0, 10)
            .map(
              (t) =>
                `任务 ${t.id} · ${t.state}${t.resultPath ? " · " + t.resultPath : ""}`,
            ),
          "最近主对话工具记录：",
          ...detail.receipts.map(
            (r) =>
              `${r.id} · ${r.tool} · ${r.finishedAt ? (r.isError ? "失败" : "已返回") : "未收束"}\n${r.input}${r.output ? "\n" + r.output : ""}`,
          ),
        ].flatMap((line) => wrapTextWithAnsi(cleanText(line, 5000), columns));
        footer = "↑↓ 滚动 · f 聚焦 · r 重新打开 · Esc 返回目标树";
        this.scroll = Math.min(
          this.scroll,
          Math.max(0, body.length - (height - heading.length - 2)),
        );
        body = body.slice(
          this.scroll,
          this.scroll + Math.max(1, height - heading.length - 2),
        );
      } else {
        const started = new Set(
          nodes
            .filter((n) => ["active", "review", "accepted"].includes(n.state))
            .map((n) => n.id),
        );
        for (const node of [...nodes].sort((a, b) => b.depth - a.depth))
          if (node.parentId && started.has(node.id)) started.add(node.parentId);
        const selected = Math.max(
            0,
            rows.findIndex((n) => n.id === this.selectedId),
          ),
          capacity = Math.max(1, height - heading.length - 3);
        this.scroll = Math.max(0, Math.min(this.scroll, selected));
        if (selected >= this.scroll + capacity)
          this.scroll = selected - capacity + 1;
        body = rows.slice(this.scroll, this.scroll + capacity).map((goal) => {
          const children = nodes.filter(
            (n) =>
              n.parentId === goal.id &&
              !["cancelled", "skipped"].includes(n.state),
          );
          const prefix = children.length
            ? this.expanded.has(goal.id)
              ? "▾"
              : "▸"
            : "·";
          const state =
            goal.rootId !== current?.id && goal.state === "active"
              ? "待继续"
              : goal.state === "planned" && children.length
                ? children.every((n) => n.state === "accepted")
                  ? "待验收"
                  : started.has(goal.id)
                    ? "进行中"
                    : "待推进"
                : goalStateNames[goal.state];
          return `${goal.id === this.selectedId ? "▶" : " "} ${"  ".repeat(Math.min(12, goal.depth - 1))}${prefix} ${goal.objective} · ${state}${children.length ? ` [${children.filter((n) => n.state === "accepted").length}/${children.length}]` : ""}${goal.id === current?.id ? " · 当前主目标" : goal.depth === 1 ? " · 未激活" : ""}${goal.id === progress.focus?.id ? " · 当前焦点" : ""}`;
        });
        if (!rows.length) body = ["尚无目标；模型可用 goal_plan 登记计划。"];
        footer =
          "↑↓ 选择 · ←→ 展开 · Enter 证据 · a 激活主目标 · f 聚焦 · Esc 返回";
        const effort =
          progress.remainingEffortMs[1] > 0
            ? `${progress.unestimated ? "已估算部分" : "剩余预计投入"} ${Math.ceil(progress.remainingEffortMs[0] / 60000)}–${Math.ceil(progress.remainingEffortMs[1] / 60000)}分钟`
            : progress.unestimated
              ? "剩余投入尚未估算"
              : "叶子项已验收";
        body.push(
          `${effort}${progress.unestimated ? ` · 尚未估算 ${progress.unestimated}项` : ""} · /mission goals export <新文件>`,
        );
      }
      const lines = [
        ...heading,
        ...(this.error ? [`提示：${this.error}`] : []),
        ...body,
      ];
      return [...lines.slice(0, height - 1), footer].map((line, index) =>
        panelLine(
          index === 0
            ? (this.theme?.fg?.("accent", line) ?? line)
            : truncateToWidth(line, columns),
          columns,
          "customMessageBg",
          this.theme,
        ),
      );
    } catch (error) {
      this.error = cleanText(String(error), 300);
      return ["目标看板暂时无法显示", this.error, "Esc 返回"].map((line) =>
        truncateToWidth(line, columns),
      );
    }
  }
  handleInput(data: string) {
    if (this.disposed) return;
    try {
      this.error = "";
      if (matchesKey(data, "escape") || data === "q") {
        if (this.detailId) {
          this.detailId = undefined;
          this.scroll = 0;
        } else {
          this.dispose();
          this.done();
        }
      } else if (this.detailId) {
        if (matchesKey(data, "down")) this.scroll++;
        else if (matchesKey(data, "up"))
          this.scroll = Math.max(0, this.scroll - 1);
        else if (matchesKey(data, "pageDown")) this.scroll += 10;
        else if (matchesKey(data, "pageUp"))
          this.scroll = Math.max(0, this.scroll - 10);
        else if (data === "f") this.kernel.focusGoal(this.detailId);
        else if (data === "r")
          this.kernel.editGoal(this.detailId, {
            state: "planned",
            reason: "User reopened goal in detailed board",
          });
      } else {
        const { rows } = this.tree(),
          index = Math.max(
            0,
            rows.findIndex((n) => n.id === this.selectedId),
          ),
          goal = rows[index];
        if (matchesKey(data, "down"))
          this.selectedId = rows[Math.min(rows.length - 1, index + 1)]?.id;
        else if (matchesKey(data, "up"))
          this.selectedId = rows[Math.max(0, index - 1)]?.id;
        else if (matchesKey(data, "pageDown"))
          this.selectedId = rows[Math.min(rows.length - 1, index + 10)]?.id;
        else if (matchesKey(data, "pageUp"))
          this.selectedId = rows[Math.max(0, index - 10)]?.id;
        else if (goal && matchesKey(data, "right")) this.expanded.add(goal.id);
        else if (goal && matchesKey(data, "left")) {
          if (this.expanded.has(goal.id)) this.expanded.delete(goal.id);
          else this.selectedId = goal.parentId ?? goal.id;
        } else if (goal && matchesKey(data, "enter")) {
          this.detailId = goal.id;
          this.scroll = 0;
        } else if (goal && data === "a") this.kernel.activateGoal(goal.rootId);
        else if (goal && data === "f") this.kernel.focusGoal(goal.id);
      }
    } catch (error) {
      this.error = cleanText(String((error as Error).message ?? error), 300);
    }
    this.redraw();
  }
}
