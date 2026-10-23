/** Recognize a direct workspace instruction, never extract commands from prose,
 * quotations, code blocks or historical transcripts. Paths stay opaque here;
 * planRelocation remains responsible for filesystem validation.
 */
export type ProjectRequest =
  | { action: "rename" | "switch"; target: string }
  | { action: "revoke" };

export function projectRequest(text: string): ProjectRequest | undefined {
  const value = text.trim();
  if (!value || value.length > 4096 || /[\r\n\x00]/.test(value)) return;
  if (
    /^(?:请|请你|帮我)?(?:取消|撤销)(?:这次|本次)?(?:工作区|项目文件夹|仓库文件夹)?(?:改名|重命名|切换)(?:授权|操作)?(?:了|吧)?[。！!]?$/u.test(
      value,
    ) ||
    /^(?:先)?(?:不要|别)(?:给)?(?:工作区|项目文件夹|仓库文件夹)?(?:改名|重命名|切换)(?:工作区)?(?:了|吧)?[。！!]?$/u.test(
      value,
    ) ||
    /^(?:please\s+)?(?:cancel|revoke)\s+(?:the\s+)?(?:workspace\s+)?(?:rename|switch)(?:\s+request)?[.!]?$/i.test(
      value,
    )
  )
    return { action: "revoke" };

  const prefix =
    "(?:(?:请你|请|麻烦你|麻烦|帮我|我希望|我想)(?:帮我)?)?(?:把|将)?";
  const workspace =
    "(?:当前|这个|本)?(?:本地)?(?:工作区(?:文件夹|目录)?|项目文件夹|项目目录|仓库文件夹|仓库目录|文件夹|目录)";
  const rename = new RegExp(
    `^${prefix}${workspace}(?:的名字|的名称)?(?:重命名为|重命名成|重命名叫|改名为|改名成|改名叫|改为|改成)(.+)$`,
    "u",
  ).exec(value);
  const change = new RegExp(
    `^${prefix}(?:当前会话的)?(?:工作区|工作目录|项目目录)(?:切换到|切换为)(.+)$`,
    "u",
  ).exec(value);
  const english =
    /^(?:please\s+)?(?:(rename)\s+(?:the\s+)?(?:current\s+)?workspace(?:\s+folder)?\s+to|(switch)\s+(?:the\s+)?(?:current\s+)?workspace\s+to)\s+(.+)$/i.exec(
      value,
    );
  const action = rename || english?.[1] ? "rename" : "switch";
  const raw = rename?.[1] ?? change?.[1] ?? english?.[3];
  if (!raw) return;

  // Sentence suffixes are outside quoted targets. Quoting preserves spaces and
  // punctuation in names, and makes a following discussion fail closed.
  let targetText = raw.trim();
  for (let i = 0; i < 5; i++) {
    const next = targetText
      .replace(
        /(?:[，,]\s*)?(?:(?:并|同时)?保留当前(?:对话|会话)|帮我执行|直接执行|请执行|并切换过去|并切换到新目录|谢谢|吧)[。！!]?$/u,
        "",
      )
      .trim();
    if (next === targetText) break;
    targetText = next;
  }
  const quoted =
    /^(?:"([^"\r\n]+)"|'([^'\r\n]+)'|“([^“”\r\n]+)”|「([^「」\r\n]+)」)[。！!.]?$/u.exec(
      targetText,
    );
  let target = quoted?.slice(1).find((part) => part !== undefined);
  if (target === undefined) {
    // Bare names are a single token. Multiword names and paths use quotes, so
    // explanations, questions and conditional requests cannot become a target.
    target = targetText.replace(/[。！!]$/u, "");
    if (!target || /[\s"'“”「」`<>，,。！？!?；;]/u.test(target)) return;
    if (/(?:吗|么|怎么样|的话)$/u.test(target)) return;
  }
  return { action, target };
}
