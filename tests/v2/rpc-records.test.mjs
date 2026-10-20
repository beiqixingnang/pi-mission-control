import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { rpcRecords } from "../../runtime/rpc-records.ts";

test("oversized cumulative snapshots drain across arbitrary chunks before canonical settlement", async () => {
  const chunk = Buffer.from("synthetic public source ".repeat(4096));
  async function* source() {
    yield '{"type":"agent_start"}\n{"ty';
    yield 'pe":"agent_end","messages":["';
    for (let i = 0; i < 1024; i++) yield chunk;
    yield '"]}\n{"type":"turn_end","message":"';
    for (let i = 0; i < 120; i++) yield chunk;
    yield '"}\r\n{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"PUBLIC 中文\u2028result"}]}}\n{"type":"agent_settled","aborted":false}\n';
  }
  const records = [];
  for await (const line of rpcRecords(Readable.from(source())))
    records.push(JSON.parse(line));
  assert.deepEqual(
    records.map((r) => r.type),
    ["agent_start", "message_end", "agent_settled"],
  );
  assert.equal(records[1].message.content[0].text, "PUBLIC 中文\u2028result");
});
test("large canonical messages still fail visibly; embedded event names cannot bypass limits", async () => {
  for (const prefix of [
    '{"type":"message_end","text":"',
    '{"type":"response","text":"',
    '{"text":"agent_end',
  ]) {
    await assert.rejects(async () => {
      for await (const line of rpcRecords(
        Readable.from([prefix, "x".repeat(9000), '"}\n']),
        8192,
      )) {
      }
    }, /canonical RPC record/);
  }
  await assert.rejects(async () => {
    for await (const line of rpcRecords(
      Readable.from(['{"type":"agent_settled"}']),
    )) {
    }
  }, /incomplete/);
  await assert.rejects(async () => {
    for await (const line of rpcRecords(
      Readable.from(['{"type":"agent_end","messages": [']),
    )) {
    }
  }, /incomplete/);
});
