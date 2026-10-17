import ts from "typescript";

export const MARKER = "PI_MISSION_TIMESTAMP_ADAPTER_V1";
const CLASSES = {
  "user-message.js": ["UserMessageComponent", "user"],
  "assistant-message.js": ["AssistantMessageComponent", "assistant"],
  "tool-execution.js": ["ToolExecutionComponent", "tool"],
  "custom-message.js": ["CustomMessageComponent", "custom"],
};
function bridge(classes) {
  return `\n/* ${MARKER} */\n;(() => {
  globalThis[Symbol.for("pi-mission-control.timestamp-adapter.v1")] = true;
  for (const [Component, kind] of [${classes.map(([name, kind]) => `[${name},${JSON.stringify(kind)}]`).join(",")}]) {
    const original = Component.prototype.render;
    Component.prototype.render = function(width) {
      const lines = original.call(this, width);
      const decorate = globalThis[Symbol.for("pi-mission-control.timestamp-renderer.v1")];
      if (typeof decorate !== "function") return lines;
      try {
        const result = decorate(lines, {
          kind, width, theme,
          timestamp: kind === "user" ? this[Symbol.for("pi-mission-control.message-time.v1")] : kind === "assistant" ? this.lastMessage?.timestamp : this.message?.timestamp,
          toolCallId: kind === "tool" ? this.toolCallId : undefined,
          isPartial: kind === "tool" ? this.isPartial : undefined,
          isError: kind === "tool" ? this.result?.isError : undefined,
          durationMs: kind === "tool" ? this.result?.durationMs : undefined
        });
        return Array.isArray(result) && result.every(line => typeof line === "string") ? result : lines;
      } catch { return lines; }
    };
  }
})();\n`;
}

/** Version/shape checked, additive metadata bridge. No message content is edited. */
export function patchPiTimestampFile(relative, source) {
  if (source.includes(MARKER)) throw new Error(`Already adapted: ${relative}`);
  const file = ts.createSourceFile(
    relative,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const basename = relative.split(/[\\/]/).at(-1);
  const bundled = relative.replaceAll("\\", "/").includes("/bundle/chunks/");
  const interactive = basename === "interactive-mode.js";
  const classes = bundled
    ? Object.values(CLASSES)
    : CLASSES[basename]
      ? [CLASSES[basename]]
      : [];
  if (!classes.length && !interactive)
    throw new Error(`Unsupported adapter target: ${relative}`);
  for (const [name] of classes) {
    let count = 0;
    const visit = (node) => {
      if (ts.isClassDeclaration(node) && node.name?.text === name) count++;
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === name &&
        node.initializer &&
        ts.isClassExpression(node.initializer)
      )
        count++;
      ts.forEachChild(node, visit);
    };
    visit(file);
    if (count !== 1)
      throw new Error(`Expected one ${name}, found ${count}: ${relative}`);
  }
  const edits = [];
  if (bundled || interactive) {
    const visit = (node) => {
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "UserMessageComponent"
      ) {
        let method = node.parent;
        while (
          method &&
          !(
            ts.isMethodDeclaration(method) &&
            method.name.getText(file) === "addMessageToChat"
          )
        )
          method = method.parent;
        const parameter = method?.parameters[0]?.name;
        if (!parameter || !ts.isIdentifier(parameter))
          throw new Error(`Unknown user-message owner: ${relative}`);
        edits.push({
          start: node.getStart(file),
          end: node.end,
          value: `Object.assign(${node.getText(file)}, { [Symbol.for("pi-mission-control.message-time.v1")]: ${parameter.text}.timestamp })`,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    if (edits.length !== 2)
      throw new Error(
        `Expected two user-message constructors, found ${edits.length}: ${relative}`,
      );
  }
  let output = source;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    output = output.slice(0, edit.start) + edit.value + output.slice(edit.end);
  output += classes.length ? bridge(classes) : `\n/* ${MARKER} */\n`;
  return output;
}
