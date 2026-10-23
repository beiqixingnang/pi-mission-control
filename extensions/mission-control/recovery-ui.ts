import { Input, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { RecoverySession } from "../../runtime/session-catalog.ts";
import { cleanText } from "../../runtime/public.ts";

export class RecoveryPicker {
  private input = new Input();
  private selected = 0;
  private sessions: RecoverySession[];
  private target: string;
  private redraw: () => void;
  private done: (session: RecoverySession | undefined) => void;
  private height: () => number;
  constructor(
    sessions: RecoverySession[],
    target: string,
    redraw: () => void,
    done: (session: RecoverySession | undefined) => void,
    height: () => number,
  ) {
    this.sessions = sessions;
    this.target = target;
    this.redraw = redraw;
    this.done = done;
    this.height = height;
    this.input.focused = true;
  }
  private rows() {
    const query = this.input.getValue().toLocaleLowerCase();
    return this.sessions.filter((s) =>
      `${s.name} ${s.cwd} ${s.id}`.toLocaleLowerCase().includes(query),
    );
  }
  handleInput(data: string) {
    const rows = this.rows();
    if (matchesKey(data, "escape")) {
      this.done(undefined);
      return;
    }
    if (matchesKey(data, "enter")) {
      if (rows[this.selected]) this.done(rows[this.selected]);
      return;
    }
    if (matchesKey(data, "up")) this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, "down"))
      this.selected = Math.min(rows.length - 1, this.selected + 1);
    else if (matchesKey(data, "pageDown"))
      this.selected = Math.min(rows.length - 1, this.selected + 8);
    else if (matchesKey(data, "pageUp"))
      this.selected = Math.max(0, this.selected - 8);
    else {
      this.input.handleInput(data);
      if (this.input.getValue().length > 2000)
        this.input.setValue(this.input.getValue().slice(0, 2000));
      this.selected = 0;
    }
    this.redraw();
  }
  render(width: number): string[] {
    const fit = (text: string) =>
      truncateToWidth(
        cleanText(text, 4000).replace(/[\r\n\t\u2028\u2029]/g, " "),
        width,
      );
    const rows = this.rows(),
      count = Math.max(1, Math.min(8, Math.floor((this.height() - 14) / 2))),
      start = Math.max(0, this.selected - count + 1);
    return [
      fit("恢复对话到当前工作区"),
      fit(this.target),
      fit("输入搜索 · ↑↓选择 · Enter 恢复到当前目录 · Esc 取消"),
      ...this.input.render(width),
      ...rows
        .slice(start, start + count)
        .flatMap((s, i) => [
          fit(`${start + i === this.selected ? "▶" : " "} ${s.name || s.id}`),
          fit(
            `  ${new Date(s.modified).toLocaleString()} · ${s.cwd}${s.missing ? " [旧目录不存在，可恢复]" : ""}`,
          ),
        ]),
      ...(rows.length ? [] : [fit("没有匹配的对话")]),
      fit(`${rows.length} 个对话；恢复会保留历史与关联数据，任务保持暂停。`),
    ];
  }
  invalidate() {
    this.input.invalidate();
  }
}
