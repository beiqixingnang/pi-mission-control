import { truncateToWidth } from "@earendil-works/pi-tui";
import { cleanText } from "../../runtime/public.ts";
import { terminal } from "../../runtime/types.ts";
import type { MissionKernel } from "../../runtime/kernel.ts";
import { panelLine, type UiTheme } from "./presentation.ts";

export const stateNames: Record<string, string> = {
  active: "推进中",
  paused: "用户暂停",
  waiting_user: "等待用户",
  complete: "已验收",
  stopped: "已停止",
  attention: "需要处理",
  queued: "排队",
  running: "执行中",
  waiting: "等待下游",
  completed: "完成",
  failed: "失败",
  cancelled: "取消",
  interrupted: "中断待核对",
};

export function board(
  kernel: MissionKernel,
  width: number,
  expanded = false,
  theme?: UiTheme,
  terminalRows = 30,
): string[] {
  const s = kernel.snapshot(),
    m = s.mission;
  const active = s.tasks.filter((t) => !terminal(t));
  const running = active.filter((t) => t.state === "running").length;
  const waiting = active.filter((t) => t.state === "waiting").length;
  const pending = s.deliveries.filter(
    (d) =>
      ["pending", "leased", "admitted"].includes(d.state) &&
      ["failure", "decision", "recovery"].includes(d.kind),
  ).length;
  const heading = `任务看板 · ${m ? stateNames[m.status] : "就绪"} · 成员 ${s.members.length} · 执行 ${running} · 等待 ${waiting}${pending ? ` · 待处理 ${pending}` : ""}`;
  const title = theme?.bold?.(heading) ?? heading;
  const lines = [theme?.fg?.("accent", title) ?? title];
  lines.push(
    m
      ? `目标  ${cleanText(m.objective.replace(/\s+/g, " "), 400)}`
      : "目标  首次派工自动建立；/mission start 可设置明确目标",
  );
  const report = m?.status === "active" && !s.held ? s.nextReportAt : undefined;
  const schedules = s.schedules.filter(
    (schedule) => schedule.state === "active",
  );
  const next = schedules[0];
  const held = s.held || m?.humanPaused;
  const due = (time: number) =>
    time <= Date.now()
      ? "已到期"
      : `${Math.max(1, Math.ceil((time - Date.now()) / 60000))}分后`;
  const timers = [
    report
      ? `进度汇报 ${due(report)}`
      : m?.status === "complete"
        ? "进度汇报 已结束"
        : "进度汇报 待运行",
    next
      ? `提醒 ${schedules.length}项 · ${cleanText(next.title.replace(/\s+/g, " "), 60)}${held ? "（暂停）" : ` ${due(next.nextAt)}`}`
      : "提醒 无",
  ];
  lines.push(timers.join(" · "));
  // A small terminal keeps at least two thirds of its height for conversation and input.
  const limit = expanded
    ? 100
    : Math.max(4, Math.min(10, Math.floor(terminalRows / 3)));
  const visible = s.members.slice(0, expanded ? 100 : Math.max(0, limit - 4));
  for (const member of visible) {
    const tasks = s.tasks.filter((task) => task.memberId === member.id);
    const task =
      tasks.find((t) => t.state === "running") ??
      tasks.find((t) => t.state === "waiting") ??
      tasks.find((t) => t.state === "queued") ??
      tasks[0];
    const activity = kernel.store.get<{ tool?: string }>(
      `activity:${member.id}`,
    );
    const status = task ? stateNames[task.state] : "待命";
    const marker =
      task?.state === "running"
        ? "●"
        : task?.state === "completed"
          ? "✓"
          : task?.state === "failed"
            ? "!"
            : "○";
    const detail = task?.blockedReason
      ? cleanText(task.blockedReason.replace(/\s+/g, " "), 120)
      : task?.state === "running"
        ? activity?.tool
        : undefined;
    lines.push(
      `${marker} ${member.name}  ${status}${detail ? ` · ${detail}` : ""}`,
    );
  }
  const more = Math.max(0, s.members.length - visible.length);
  lines.push(
    `${more ? `另有 ${more}名成员 · ` : ""}/agents 查看/发消息 · /mission 目标与提醒${kernel.store.get("relocationHold") ? " · 工作区待确认" : held ? " · 自动推进暂停" : ""}`,
  );
  if (expanded) {
    if (m)
      lines.push(
        `自动接续 ${m.turns}/${kernel.settings.maxAutonomousTurns} · 主输出 ${m.outputTokens}/${kernel.settings.maxOutputTokens}`,
      );
    if (m?.reason) lines.push(`需处理：${cleanText(m.reason, 240)}`);
    lines.push("", "任务与交付");
    for (const task of s.tasks.slice(0, 100))
      lines.push(
        `${task.parentId ? "  ↳ " : ""}${task.member}: ${stateNames[task.state]} · ${task.phase} · ${task.id}${task.resultPath ? `\n  ${task.resultPath}` : ""}`,
      );
    for (const delivery of s.deliveries
      .filter((d) => d.state !== "observed")
      .slice(0, 30))
      lines.push(
        `待查看 ${delivery.kind} · ${delivery.from}: ${cleanText(delivery.summary, 200)}`,
      );
    lines.push("Esc 返回 · /mission pause|resume|stop 控制任务");
  }
  return lines
    .flatMap((line) => line.split("\n"))
    .map((line) =>
      panelLine(
        truncateToWidth(line, Math.max(1, width)),
        width,
        "customMessageBg",
        theme,
      ),
    );
}
