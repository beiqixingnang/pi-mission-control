import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
type SwitchOptions = NonNullable<
  Parameters<ExtensionCommandContext["switchSession"]>[1]
>;
type ReplacementContext = Parameters<
  NonNullable<SwitchOptions["withSession"]>
>[0];

/** A committed move remains valid if an immediate reload replaces its UI ctx. */
export async function projectNotice(
  next: Pick<ReplacementContext, "sendMessage" | "ui">,
  notice: string,
  content?: string,
) {
  try {
    if (content)
      await next.sendMessage({
        customType: "project-location",
        content,
        display: true,
      });
    next.ui.notify(notice, "info");
    return true;
  } catch (error) {
    if (
      /This extension ctx is stale after session replacement or reload/.test(
        String(error),
      )
    )
      return false;
    throw error;
  }
}
