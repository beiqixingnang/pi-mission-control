import type { Theme, ThemeBg } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type UiTheme = Partial<
  Pick<Theme, "fg" | "bg" | "bold" | "italic" | "strikethrough" | "underline">
>;

/** Match Pi's padded message panels without adding a border to selectable text. */
export function panelLine(
  text: string,
  width: number,
  background: ThemeBg | undefined,
  theme?: UiTheme,
) {
  const line = truncateToWidth(text, Math.max(1, width));
  if (!background || !theme?.bg) return line;
  return theme.bg(
    background,
    line + " ".repeat(Math.max(0, width - visibleWidth(line))),
  );
}
