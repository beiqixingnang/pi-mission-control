import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { streamPublicSession } from "../../runtime/public.ts";
import { summarizeChunks } from "../../runtime/summarize.ts";
import { privateAddress, searchWeb, fetchPage } from "../../runtime/web.ts";
import { workerEnvironment } from "../../runtime/rpc-worker.ts";

test("large session export reads LF records, drops snapshots and private blocks, and preserves public tool evidence", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mc-v2-export-"));
  try {
    const file = path.join(directory, "source.jsonl"),
      fd = fs.openSync(file, "w");
    for (let i = 0; i < 1500; i++)
      fs.writeSync(
        fd,
        JSON.stringify({
          type: "custom",
          customType: "team-roster",
          data: { payload: "x".repeat(64000) },
        }) + "\n",
      );
    fs.writeSync(
      fd,
      JSON.stringify({
        type: "message",
        message: { role: "system", content: "PRIVATE_SYSTEM" },
      }) + "\n",
    );
    fs.writeSync(
      fd,
      JSON.stringify({
        type: "message",
        id: "public",
        message: {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "PRIVATE_REASONING",
              signature: "PRIVATE_SIGNATURE",
            },
            { type: "text", text: "public\u2028still one LF record" },
            {
              type: "toolCall",
              id: "call",
              name: "read",
              arguments: { path: "fixture.txt" },
            },
          ],
        },
      }) + "\n",
    );
    fs.writeSync(
      fd,
      JSON.stringify({
        type: "message",
        message: {
          role: "toolResult",
          toolName: "read",
          content: [{ type: "text", text: "verified output" }],
        },
      }) + "\n",
    );
    fs.closeSync(fd);
    const out = new PassThrough();
    let output = "";
    out.on("data", (x) => {
      output += x;
    });
    assert.equal(await streamPublicSession(file, out), 2);
    out.end();
    assert.match(output, /verified output/);
    assert.match(output, /fixture.txt/);
    assert.doesNotMatch(output, /PRIVATE_|team-roster|signature|thinking/);
    assert.ok(output.length < 2000);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("chunked summary caches successful work, resumes failures and never sends an oversized prompt", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mc-v2-summary-"));
  let calls = 0,
    fail = true;
  const prompts = [];
  try {
    const complete = async (prompt) => {
      calls++;
      prompts.push(prompt);
      if (fail && calls === 2) throw new Error("provider failure");
      return {
        stopReason: "stop",
        content: [{ type: "text", text: "concise result " + calls }],
      };
    };
    const options = {
      directory,
      model: "test/model",
      maxInputChars: 2000,
      maxOutputChars: 200,
      complete,
    };
    await assert.rejects(
      summarizeChunks(["a".repeat(5000)], options),
      /provider failure/,
    );
    assert.equal(calls, 2);
    fail = false;
    const result = await summarizeChunks(["a".repeat(5000)], options);
    assert.match(result, /concise/);
    assert.ok(prompts.every((p) => p.length <= 2000));
    const before = calls;
    await summarizeChunks(["a".repeat(5000)], options);
    assert.equal(calls, before, "same chunks and merge re-use checkpoints");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("length-truncated or empty summaries cannot replace history", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "mc-v2-summary-fail-"),
  );
  try {
    await assert.rejects(
      summarizeChunks(["text"], {
        directory,
        model: "m",
        maxInputChars: 2000,
        maxOutputChars: 300,
        complete: async () => ({
          stopReason: "length",
          content: [{ type: "text", text: "partial" }],
        }),
      }),
      /truncated/,
    );
    assert.equal(fs.readdirSync(directory).length, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("search sends only the query and returns explicit provider and source text", async () => {
  let body;
  const response = await searchWeb(
    "Pi extension API",
    { searchProvider: "exa" },
    undefined,
    async (_url, options) => {
      body = JSON.parse(options.body);
      return new Response(
        JSON.stringify({
          result: {
            content: [
              {
                type: "text",
                text: "Title: Pi API\nURL: https://example.org/docs",
              },
            ],
          },
        }),
      );
    },
  );
  assert.equal(body.params.arguments.query, "Pi extension API");
  assert.equal(response.provider, "exa");
  assert.match(response.content, /example.org/);
  assert.doesNotMatch(JSON.stringify(body), /systemPrompt|messages|session/);
});

test("network guard rejects private/mapped addresses and worker environments do not inherit arbitrary secrets", () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "::1",
    "::ffff:127.0.0.1",
  ])
    assert.equal(privateAddress(ip), true, ip);
  assert.equal(privateAddress("8.8.8.8"), false);
  const previous = process.env.MC_FIXTURE_SECRET;
  process.env.MC_FIXTURE_SECRET = "do-not-inherit";
  try {
    const env = workerEnvironment({
      member: {},
      task: { id: "t", epoch: 1 },
      directory: "d",
      bridgeUrl: "u",
      token: "token",
      settings: { inheritEnv: [] },
    });
    assert.equal(env.MC_FIXTURE_SECRET, undefined);
    assert.equal(env.MC_V2_TOKEN, "token");
  } finally {
    if (previous === undefined) delete process.env.MC_FIXTURE_SECRET;
    else process.env.MC_FIXTURE_SECRET = previous;
  }
});

test("web fetch rechecks redirects and rejects private destinations before connecting", async () => {
  let calls = 0;
  await assert.rejects(
    fetchPage("http://127.0.0.1/private", undefined, async () => {
      calls++;
      return new Response("secret");
    }),
    /Private/,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    fetchPage("https://8.8.8.8/source", undefined, async () => {
      calls++;
      return new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/credentials" },
      });
    }),
    /Private/,
  );
  assert.equal(calls, 1);
  const page = await fetchPage(
    "https://8.8.8.8/source",
    undefined,
    async () =>
      new Response(
        "<script>hidden</script><h1>Public page</h1><p>verified text</p>",
        { headers: { "content-type": "text/html" } },
      ),
  );
  assert.equal(page.text, "Public page verified text");
});
test("search handles MCP event-stream framing before data records", async () => {
  const result = await searchWeb(
    "framed query",
    { searchProvider: "exa" },
    undefined,
    async () =>
      new Response(
        "event: message\ndata: " +
          JSON.stringify({
            result: {
              content: [
                { type: "text", text: "source: https://example.org/framed" },
              ],
            },
          }) +
          "\n\n",
        { headers: { "content-type": "text/event-stream" } },
      ),
  );
  assert.match(result.content, /example.org\/framed/);
});
