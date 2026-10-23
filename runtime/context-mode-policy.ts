import type { ContextMode } from "./context-memory.ts";

export type ContextRole = "lead" | "member";
const modeWords =
  /压缩(?:模式)?|摘要(?:模式)?|\bsummary\b|\bsummari[sz]ation\b|\bcompaction\b|笔记(?:模式)?|记笔记|\bnotes?\b|实验性上下文/giu;
const memberWords =
  /子智能体|子代理|子模型|成员|\bsubagents?\b|\bworkers?\b|\bmembers?\b/giu;
const leadWords =
  /主对话|主会话|主模型|主智能体|当前对话|当前会话|本对话|本会话|\blead\b|\bmain(?: conversation| session)?\b/giu;

function subject(text: string, fallback: ContextRole): ContextRole {
  const member = [...text.matchAll(memberWords)].at(-1)?.index ?? -1;
  const lead = [...text.matchAll(leadWords)].at(-1)?.index ?? -1;
  return member < 0 && lead < 0 ? fallback : member > lead ? "member" : "lead";
}

/** Read a current human instruction, not a transcript or a model's tool output.
 * Accept ordinary Chinese/English requests and a confirmation of a concrete
 * preceding proposal. Ambiguous discussion grants no mode change.
 */
export function requestedContextMode(
  text: string,
  role: ContextRole,
  precedingProposal = "",
): ContextMode | undefined {
  if (!text || text.length > 32768) return;
  const plain = text
    .replace(/```[\s\S]*?(?:```|$)/g, "")
    .replace(/(?:[\w-]+:)?\{[^\r\n]*\}/g, "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:>|\{|\[)/.test(line))
    .join("\n");
  if (/先讨论|只读|先不改|先别改|not yet|read.only/iu.test(plain)) return;
  if (/先别执行|先别动|暂不执行|保持现状|别动现有|先不要执行/iu.test(plain))
    return;
  const confirmation =
    /^(?:可以|好的?|行|同意|没问题|就这么办|照(?:你|刚才|上面).{0,24}(?:办|做|切|改)|yes\b|ok(?:ay)?\b|agreed\b|go ahead\b)/iu;
  if (
    confirmation.test(plain.trim()) &&
    ![...plain.matchAll(modeWords)].length &&
    !/[?？]|先讨论|只读|先别|不要|取消|撤销|not yet|do not|don't/iu.test(
      plain,
    ) &&
    /建议|推荐|要不要|是否|可以.{0,16}(?:切|换|改)|recommend|suggest|shall|would you|may i/iu.test(
      precedingProposal,
    )
  ) {
    const proposed = requestedContextMode(
      precedingProposal.replace(/[?？]/g, "").replace(/要不要|是否/g, "请"),
      role,
    );
    if (proposed) return proposed;
  }
  let currentSubject = role;
  const choices: ContextMode[] = [];
  for (const clause of plain.split(/[，,。！？!?；;\n]/u)) {
    const value = clause.trim();
    if (!value) continue;
    const matches = [...value.matchAll(modeWords)];
    if (!matches.length) {
      currentSubject = subject(value, currentSubject);
      continue;
    }
    if (
      /先讨论|只读|先不改|先别改|不要.{0,8}(?:切换|更改|改动)|不得.{0,8}(?:切换|更改)|禁止.{0,8}(?:切换|更改)|(?:你|它|他)说|日志|示例|例如|比如|假设|原话|发现|看到|看见|好像|似乎|显示|曾经|印象|说明|I (?:see|saw|noticed)|looks like|quotation|example|read.only|(?:do not|don't|never)\s+(?:change|switch|use|enable)|^(?:之前|以前|此前|昨天|上次|刚才)/iu.test(
        value,
      ) ||
      (/是否|是不是|什么|如何|怎么|为什么|能否|有没有|会不会|好不好|行不行|你觉得|能不能|可不可以|which|why|what|how|whether/iu.test(
        value,
      ) &&
        !/请.{0,12}(?:切|换|改|用)|改成|改回|切换到|切换为|切回|换成|换回|我希望|我想让|就用|默认/iu.test(
          value,
        ))
    ) {
      currentSubject = subject(value, currentSubject);
      continue;
    }
    const clauseChoices: ContextMode[] = [];
    for (const match of matches) {
      const prefix = value.slice(0, match.index);
      const shortSelection =
        !/[?？]/u.test(plain) &&
        (/^(?:那就|就|还是)?\s*(?:压缩|摘要|笔记|summary|notes)(?:模式)?(?:吧|就好|就行|please)?$/iu.test(
          value,
        ) ||
          /^(?:以后|今后|接下来|这次)?(?:主对话|主会话|主模型|当前会话|当前对话|子智能体|成员|main conversation|subagents?)\s*(?:压缩|摘要|笔记|summary|notes)(?:模式)?(?:吧|就行)?$/iu.test(
            value,
          ));
      if (
        !shortSelection &&
        !/(?:切换(?:到|为|成)?|切回|改(?:成|为|回|用)|换(?:成|为|回|用)|设置(?:为|成)?|设为|选择|启用|开启|恢复(?:成|为|到)?|保持|默认(?:为|用)?|回到|使用|(?<!调|利|作)用|\b(?:switch|change|use|set|keep|enable|return|go back)\b)[^，,。！？!?；;\n]{0,28}$/iu.test(
          prefix,
        )
      )
        continue;
      if (
        /^\s*(?:模型|model\b)/iu.test(
          value.slice(match.index + match[0].length),
        )
      )
        continue;
      if (
        !shortSelection &&
        !/模式|上下文|会话|对话|智能体|成员|context|conversation|session|main|lead|member|subagent|worker/iu.test(
          value,
        ) &&
        !/(?:改|换|切|恢复|默认|回到)|switch|change|return|go back/iu.test(
          value,
        )
      )
        continue;
      const owner = subject(prefix, subject(value, currentSubject));
      if (owner !== role) continue;
      if (
        /(?:不要(?:再|继续)?用|不要|不用|别(?:再|继续)?用|不使用|不启用|not|don't use|do not use)\s*(?:再|继续|the\s+)?$/iu.test(
          prefix,
        )
      )
        continue;
      clauseChoices.push(
        /压缩|摘要|summary|summari[sz]ation|compaction/iu.test(match[0])
          ? "summary"
          : "notes",
      );
    }
    currentSubject = subject(value, currentSubject);
    if (new Set(clauseChoices).size > 1) {
      const between = value.slice(
        matches[0].index! + matches[0][0].length,
        matches.at(-1)!.index,
      );
      if (
        (/如果|若|if\b/iu.test(value) &&
          /(?:改|切|换)(?:成|回|为|到)/u.test(value)) ||
        /(?:改|切|换)(?:成|回|为|到)|\bto\b/iu.test(between)
      )
        choices.push(clauseChoices.at(-1)!);
      else return;
    } else choices.push(...clauseChoices);
  }
  return new Set(choices).size === 1 ? choices[0] : undefined;
}
