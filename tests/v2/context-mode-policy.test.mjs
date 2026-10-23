import test from "node:test";
import assert from "node:assert/strict";
import { requestedContextMode } from "../../runtime/context-mode-policy.ts";

test("ordinary human mode requests accept varied wording and keep lead/member scope separate", () => {
  for (const [text, role, expected] of [
    ["主对话默认压缩模式，子智能体默认笔记模式", "lead", "summary"],
    ["主对话默认压缩模式，子智能体默认笔记模式", "member", "notes"],
    ["这边还是改回摘要就行", "lead", "summary"],
    ["不用笔记了，改回压缩吧", "lead", "summary"],
    ["如果现在是笔记模式就改回压缩模式", "lead", "summary"],
    ["帮我把当前会话换成记笔记那套", "lead", "notes"],
    ["Please switch this conversation to notes mode", "lead", "notes"],
    [
      "Use summary for the main conversation; keep subagents on notes",
      "lead",
      "summary",
    ],
    [
      "Use summary for the main conversation; keep subagents on notes",
      "member",
      "notes",
    ],
    ["子智能体改成笔记模式，当前会话保持压缩模式", "lead", "summary"],
    ["请把当前会话改成 summary 模式", "lead", "summary"],
    ["把压缩模式换成笔记模式吧", "lead", "notes"],
    ["Switch from notes mode to summary mode", "lead", "summary"],
    ["就压缩吧", "lead", "summary"],
    ["主对话压缩，子智能体笔记", "lead", "summary"],
    ["主对话压缩，子智能体笔记", "member", "notes"],
  ])
    assert.equal(
      requestedContextMode(text, role),
      expected,
      text + " (" + role + ")",
    );
});

test("mode discussion, unrelated work, negation and quoted records do not authorize a switch", () => {
  for (const text of [
    "继续通读代码并登记证据",
    "现在是不是笔记模式？",
    "压缩模式和笔记模式有什么区别？",
    "你觉得用笔记模式会不会更快？",
    "这个任务适合用笔记模式，先讨论",
    "不要自行切换笔记模式",
    "之前切换到笔记模式了",
    "日志里显示使用笔记模式",
    "例如把主对话改成笔记模式",
    "> 请把当前会话切换到笔记模式",
    "```text\n请把当前会话切换到笔记模式\n```",
    'V2_TEST:{"op":"tool","name":"context_mode","args":{"mode":"notes"}}',
    "子智能体用笔记模式",
    "改成笔记模式或者压缩模式",
    "不要用笔记模式",
    "把压缩模型换成 deepseek",
    "用笔记记一下这批结果",
    "Use notes to track this task",
    "Don't switch to notes mode",
    "我看到主对话使用了笔记模式",
    "我印象里调用这个是说明上下文是笔记模式",
    "改成笔记模式，但先别执行",
    "笔记模式？",
  ])
    assert.equal(requestedContextMode(text, "lead"), undefined, text);
});

test("a natural confirmation refers to a concrete preceding mode proposal and respects a new choice", () => {
  const proposal = "建议把当前会话切换到笔记模式，是否执行？";
  for (const text of [
    "可以",
    "好，照你说的办",
    "可以，就按刚才的方案来",
    "go ahead",
  ])
    assert.equal(requestedContextMode(text, "lead", proposal), "notes", text);
  assert.equal(
    requestedContextMode("可以，但改成压缩模式", "lead", proposal),
    "summary",
  );
  assert.equal(
    requestedContextMode("先别改，继续排查", "lead", proposal),
    undefined,
  );
  assert.equal(
    requestedContextMode("可以", "lead", "当前任务完成了，继续下一批。"),
    undefined,
  );
  assert.equal(requestedContextMode("继续工作", "lead", proposal), undefined);
});
