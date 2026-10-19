import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { cleanText } from "../../runtime/public.ts";
import { memberTask } from "../../runtime/roster.ts";
import type { Mission, Recovery } from "../../runtime/types.ts";
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
export function missionState(m?: Mission, recovery?: Recovery) {
  if (!m && !recovery) return "就绪";
  if (m && m.status !== "active")
    return m.blocker?.kind === "budget"
      ? "预算耗尽"
      : m.blocker?.kind === "no_progress"
        ? "进展待核对"
        : stateNames[m.status];
  if (recovery)
    return {
      waiting_compaction: "等待压缩恢复",
      compacting: "正在压缩",
      compaction_failed: "压缩失败待重试",
      cooldown: "恢复等待",
      ready: "等待恢复验证",
      probing: "恢复验证中",
      exhausted: "恢复需要检查",
    }[recovery.phase];
  return m?.externalWait ? "等待外部事件" : m ? stateNames[m.status] : "就绪";
}
function cell(text: string, width: number) {
  const value = truncateToWidth(
    cleanText(text.replace(/\s+/g, " "), 400),
    Math.max(1, width),
  );
  return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}
function duration(ms: number) {
  if (ms >= 3600000)
    return `${Math.floor(ms / 3600000)}小时${Math.floor(ms / 60000) % 60}分`;
  if (ms >= 60000) return `${Math.floor(ms / 60000)}分`;
  return `${Math.floor(ms / 1000)}秒`;
}
export function board(
  kernel: MissionKernel,
  width: number,
  expanded = false,
  theme?: UiTheme,
  terminalRows = 30,
): string[] {
  const s = kernel.snapshot(),
    m = s.mission;
  const limit = expanded
    ? 100
    : Math.max(4, Math.min(10, Math.floor(terminalRows / 3)));
  const held = s.held || m?.humanPaused || kernel.store.get("relocationHold");
  const due = (time: number) =>
    time <= Date.now()
      ? "已到期"
      : `${Math.max(1, Math.ceil((time - Date.now()) / 60000))}分后`;
  const schedules = s.schedules
    .filter((x) => x.state === "active")
    .sort((a, b) => a.nextAt - b.nextAt || a.id.localeCompare(b.id));
  const memberRows = s.members.map((member) => {
    const task = memberTask(member, s.tasks);
    const activity = kernel.store.get<{ tool?: string }>(
      `activity:${member.id}`,
    );
    return {
      category: "子智能体",
      name: member.name,
      status: task ? (stateNames[task.state] ?? task.state) : "待命",
      detail: task?.blockedReason
        ? cleanText(task.blockedReason, 160)
        : task?.state === "running"
          ? (activity?.tool ?? "工作中")
          : task?.phase === "review"
            ? "复核"
            : "",
    };
  });
  const goalDetail = `二级${s.goals.level2.completed}/${s.goals.level2.total} 三级${s.goals.level3.completed}/${s.goals.level3.total}`;
  const goal = {
    category: "目标",
    name: m?.objective ?? "首次派工自动建立",
    status: missionState(m, s.recovery),
    detail: goalDetail,
  };
  const reminderRows = schedules.map((r) => ({
    category: "定时任务",
    name: r.title,
    status: held ? "暂停投递" : r.intervalMs ? "周期提醒" : "一次提醒",
    detail: due(r.nextAt),
  }));
  if (m && !["complete", "stopped"].includes(m.status)) {
    const ready =
      m.status === "active" && !held && !s.recovery && !m.externalWait;
    reminderRows.push({
      category: "定时任务",
      name: "进度汇报",
      status: ready
        ? "每" + duration(kernel.settings.progressIntervalMs)
        : "等待恢复",
      detail: ready && s.nextReportAt ? due(s.nextReportAt) : "等待期间停发",
    });
  }
  const reminderCount = reminderRows.length;
  if (!reminderCount)
    reminderRows.push({
      category: "定时任务",
      name: "无",
      status: "—",
      detail: "",
    });
  const table = width >= 76 && limit >= 7;
  const remindersShown = Math.min(
    reminderRows.length,
    table && limit >= 10 ? 2 : 1,
  );
  const availableMembers = Math.max(0, limit - 4 - remindersShown);
  const shown = memberRows.slice(0, availableMembers);
  const hiddenMembers = memberRows.length - shown.length,
    hiddenReminders = reminderRows.length - remindersShown;
  const footer = [
    hiddenMembers ? `另有 ${hiddenMembers}名成员` : "",
    hiddenReminders ? `另有 ${hiddenReminders}项提醒` : "",
    "/mission goals 目标详情 · /agents 成员对话",
  ]
    .filter(Boolean)
    .join(" · ");
  let lines: string[];
  if (table) {
    const widths = [8, width - 57, 14, 26];
    const row = (r: {
      category: string;
      name: string;
      status: string;
      detail: string;
    }) =>
      [r.category, r.name, r.status, r.detail]
        .map((t, i) => cell(t, widths[i]))
        .join(" │ ");
    const header = row({
      category: "类别",
      name: "名称 / 内容",
      status: "状态",
      detail: "时间 / 进展",
    });
    lines = [
      theme?.fg?.("accent", theme?.bold?.(header) ?? header) ?? header,
      "─".repeat(width),
      row(goal),
      ...reminderRows.slice(0, remindersShown).map(row),
      ...shown.map(row),
      footer,
    ];
  } else {
    const running = memberRows.filter((r) => r.status === "执行中").length,
      waiting = memberRows.filter((r) => r.status === "等待下游").length;
    const memberLine = (r: typeof goal) =>
      `${cell(r.name, Math.max(1, width - 13))} ${r.status}`;
    const compactShown = memberRows.slice(0, Math.max(0, limit - 5));
    lines = [
      `目标 · ${goal.status} · ${goal.name}`,
      `${goalDetail} 已验收`,
      `定时 · ${reminderCount}项${reminderCount ? " · " + reminderRows[0].detail + " " + reminderRows[0].name : " · 无"}`,
      `成员 · ${memberRows.length}名 · 执行 ${running} · 等待 ${waiting}`,
      ...compactShown.map(memberLine),
      `${memberRows.length > compactShown.length ? `另有 ${memberRows.length - compactShown.length}名成员 · ` : ""}/mission goals 详情 · /agents 对话`,
    ];
  }
  if (expanded) {
    if (m?.reason) lines.push(`需处理：${cleanText(m.reason, 240)}`);
    if (s.recovery)
      lines.push(
        `恢复原因 ${cleanText(s.recovery.reason, 240)} · 请求 ${s.recovery.requests}/${kernel.settings.recoveryMaxRequests}`,
      );
    if (m)
      lines.push(
        `活动耗时 ${duration(s.activity?.activeMs ?? 0)} · 时间预算 ${kernel.settings.maxMissionMs ? duration(kernel.settings.maxMissionMs) : "无时间上限"}`,
        `自动接续 ${m.turns}/${kernel.settings.maxAutonomousTurns || "不限"} · 主输出 ${m.outputTokens}/${kernel.settings.maxOutputTokens || "不限"}`,
      );
    lines.push("Esc 返回 · /mission pause|resume|stop 控制任务");
  }
  return lines
    .slice(0, expanded ? 100 : limit)
    .map((line) =>
      panelLine(
        truncateToWidth(line, Math.max(1, width)),
        width,
        "customMessageBg",
        theme,
      ),
    );
}
