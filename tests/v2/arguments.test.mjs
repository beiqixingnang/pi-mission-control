import test from "node:test";
import assert from "node:assert/strict";
import { delegationInput, workspaceInput } from "../../runtime/arguments.ts";

test("empty optional arrays/null never hide a supplied task, parallel list or chain", () => {
  const chain = delegationInput({
    task: "",
    tasks: [],
    chain: [{ task: "review" }],
    agent: "reviewer",
    model: null,
  });
  assert.equal(chain.chain, true);
  assert.equal(chain.inputs[0].agent, "reviewer");
  assert.equal(chain.inputs[0].workspace.access, "read-only");
  assert.equal(
    delegationInput({ task: "single", tasks: [], chain: [] }).chain,
    false,
  );
  assert.equal(
    delegationInput({ task: null, tasks: [{ task: "parallel" }], chain: [] })
      .chain,
    false,
  );
  assert.throws(() => delegationInput({ tasks: [], chain: null }), /non-empty/);
  assert.throws(
    () => delegationInput({ task: "one", chain: [{ task: "two" }] }),
    /only one/,
  );
  assert.throws(
    () => delegationInput({ tasks: [{ task: "ok" }, { task: " " }] }),
    /Every delegated item/,
  );
});

test("empty sandbox profiles are placeholders, meaningful capability conflicts still reject", () => {
  for (const sandbox of [
    null,
    {},
    { engine: "podman", image: "", cpus: null },
  ]) {
    const w = workspaceInput({
      root: "",
      access: "read-only",
      execution: "files",
      sandbox,
    });
    assert.equal(w.sandbox, undefined);
    assert.equal(w.execution, "files");
    assert.equal(w.access, "read-only");
  }
  assert.throws(
    () =>
      workspaceInput({ execution: "files", sandbox: { image: "real-image" } }),
    /conflicts/,
  );
  assert.throws(
    () =>
      workspaceInput({ execution: "host", sandbox: { image: "real-image" } }),
    /conflicts/,
  );
  assert.deepEqual(
    workspaceInput({ execution: "sandbox", sandbox: {} }).sandbox,
    {},
  );
  const d = delegationInput({
    workspace: { root: "/parent", access: "read-only" },
    chain: [{ task: "read", workspace: { root: null, sandbox: null } }],
  });
  assert.equal(d.inputs[0].workspace.root, "/parent");
  assert.equal(d.inputs[0].workspace.access, "read-only");
});
