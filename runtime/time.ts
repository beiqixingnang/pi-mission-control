/** Display metadata only: missing timestamps must never become the current time. */
export function readTime(value: unknown): number | undefined {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.includes("T")
        ? Date.parse(value)
        : NaN;
  return Number.isFinite(number) && Number.isFinite(new Date(number).getTime())
    ? number
    : undefined;
}
export function readDuration(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}
export function messageTime(entry: {
  messageTimestamp?: unknown;
  timestamp?: unknown;
}) {
  return readTime(entry.messageTimestamp) ?? readTime(entry.timestamp);
}
export function formatTime(value: unknown, now = Date.now()) {
  const timestamp = readTime(value);
  if (timestamp === undefined) return "时间未记录";
  const date = new Date(timestamp),
    today = new Date(now);
  const pad = (n: number) => String(n).padStart(2, "0");
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  if (
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  )
    return clock;
  return `${date.getFullYear() === today.getFullYear() ? "" : `${date.getFullYear()}-`}${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}`;
}
export function formatDuration(value: number) {
  const seconds = Math.max(0, value) / 1000;
  if (seconds < 60)
    return `${seconds < 10 ? seconds.toFixed(1) : Math.floor(seconds)}秒`;
  if (seconds < 3600)
    return `${Math.floor(seconds / 60)}分${String(Math.floor(seconds % 60)).padStart(2, "0")}秒`;
  return `${Math.floor(seconds / 3600)}小时${Math.floor((seconds % 3600) / 60)}分`;
}
