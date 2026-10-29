import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (file) =>
  fs.readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");

test("runtime prompt sources contain mechanism contracts while project workflow guidance is external", () => {
  const guidance = read("runtime/guidance.ts");
  const lead = read("extensions/mission-control/index.ts");
  const member = read("extensions/mission-control/member.ts");
  assert.match(guidance, /leadMechanismGuidance/);
  assert.match(guidance, /memberMechanismGuidance/);
  for (const obsolete of [
    "goalPlanningGuidance",
    "delegationGuidance",
    "teamWorkflowGuidance",
    "memberWorkflowGuidance",
    "Before execution, inventory the full approved scope",
  ]) {
    assert.doesNotMatch(
      guidance,
      new RegExp(obsolete.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    assert.doesNotMatch(
      lead,
      new RegExp(obsolete.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    assert.doesNotMatch(
      member,
      new RegExp(obsolete.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }
  assert.match(lead, /plugin tools are direct host registrations/);
  assert.match(
    member,
    /Active tools and capability revision are authoritative/,
  );
});

test("README documents the current prompt boundary instead of an old tool-count snapshot", () => {
  const readme = read("README.md");
  assert.match(readme, /当前版本 \*\*2\.14\.0\*\*/);
  assert.match(readme, /提示词与工作流边界/);
  assert.doesNotMatch(readme, /当前版本 \*\*2\.6\.1\*\*/);
});
