import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { hostDir } from "../../scripts/host.mjs";
import { spawn } from "node:child_process";
const { loadExtensions, createExtensionRuntime } = await import(
  pathToFileURL(path.join(hostDir, "dist/core/extensions/loader.js"))
);
const { createEventBus } = await import(
  pathToFileURL(path.join(hostDir, "dist/core/event-bus.js"))
);

async function using(run) {
  const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "summary-member-route-"),
    ),
    own = path.join(directory, "sessions", "reader", "compaction-summary.json");
  const previous = process.env.MC_V2_MEMBER;
  process.env.MC_V2_MEMBER = JSON.stringify({
    directory,
    member: { id: "reader", name: "reader" },
  });
  const notifications = [],
    calls = [],
    bus = createEventBus(),
    states = [];
  bus.on("mission-control:compaction-state", (state) => states.push(state));
  const model = {
    id: "flash",
    provider: "summary-provider",
    contextWindow: 64000,
    maxTokens: 4096,
    reasoning: false,
  };
  const ctx = {
    cwd: directory,
    sessionManager: {
      getSessionId: () => "child-session",
      getBranch: () => [],
    },
    modelRegistry: {
      find: (provider, id) =>
        provider === model.provider && id === model.id ? model : undefined,
      complete: async (selected) => {
        calls.push(selected);
        return {
          stopReason: "stop",
          content: [
            {
              type: "text",
              text: "Member checkpoint selected the independent summary model",
            },
          ],
        };
      },
    },
    ui: { notify: (text) => notifications.push(text), setStatus() {} },
  };
  try {
    fs.writeFileSync(
      path.join(directory, "member-compaction-summary.json"),
      JSON.stringify({ model: "summary-provider/flash" }),
    );
    const loaded = await loadExtensions(
      [path.resolve("extensions/mission-control/compaction.ts")],
      directory,
      bus,
      createExtensionRuntime(),
    );
    assert.deepEqual(loaded.errors, []);
    const hook = loaded.extensions[0].handlers.get("session_before_compact")[0];
    const compact = () =>
      hook(
        {
          type: "session_before_compact",
          signal: new AbortController().signal,
          preparation: {
            messagesToSummarize: [
              {
                role: "user",
                content: "Evidence from a completed code audit",
                timestamp: 1,
              },
            ],
            turnPrefixMessages: [],
            tokensBefore: 100,
            firstKeptEntryId: "first",
          },
        },
        ctx,
      );
    const emit = async (type) => {
      for (const handler of loaded.extensions[0].handlers.get(type) ?? [])
        await handler({ type }, ctx);
    };
    await run({
      directory,
      own,
      ctx,
      calls,
      notifications,
      states,
      compact,
      emit,
    });
  } finally {
    if (previous === undefined) delete process.env.MC_V2_MEMBER;
    else process.env.MC_V2_MEMBER = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
test("member compaction inherits the parent-scoped member summary model instead of the inference GPT", () =>
  using(async (h) => {
    const result = await h.compact();
    assert.ok(result.compaction);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].provider, "summary-provider");
    assert.equal(h.calls[0].id, "flash");
  }));
test("reload cancels an old summary generation and ignores its late response", () =>
  using(async (h) => {
    let release, enter;
    const entered = new Promise((resolve) => {
      enter = resolve;
    });
    h.ctx.modelRegistry.complete = async () => {
      h.calls.push("delayed");
      enter();
      return await new Promise((resolve) => {
        release = resolve;
      });
    };
    const pending = h.compact();
    await entered;
    await h.emit("session_shutdown");
    await h.emit("session_start");
    assert.equal((await pending).cancel, true);
    assert.equal(h.calls.length, 1);
    release({
      stopReason: "stop",
      content: [{ type: "text", text: "LATE_MUST_NOT_COMMIT" }],
    });
    await new Promise(setImmediate);
    await new Promise(setImmediate);
    const diagnostic = JSON.parse(
      fs.readFileSync(
        path.join(h.directory, "sessions/reader/compaction-diagnostics.json"),
        "utf8",
      ),
    );
    assert.equal(diagnostic.stage, "compact:interrupted");
    assert.equal(h.states.filter((s) => s.phase === "failed").length, 0);
    const cache = path.join(h.directory, "summary-cache");
    assert.ok(
      !fs.existsSync(cache) ||
        !fs.readdirSync(cache).some((name) => name.endsWith(".txt")),
    );
  }));

test("member budget overrides retain the configured shared summary route", () =>
  using(async (h) => {
    fs.mkdirSync(path.dirname(h.own), { recursive: true });
    fs.writeFileSync(h.own, JSON.stringify({ maxInputChars: 5000 }));
    assert.ok((await h.compact()).compaction);
    assert.equal(h.calls[0].provider, "summary-provider");
  }));
test("unavailable summary models stop compaction rather than falling back to the main model", () =>
  using(async (h) => {
    fs.writeFileSync(
      path.join(h.directory, "member-compaction-summary.json"),
      JSON.stringify({ model: "wrong/missing" }),
    );
    const result = await h.compact();
    assert.equal(result.cancel, true);
    assert.equal(h.calls.length, 0);
    assert.match(
      h.notifications.join("\n"),
      /Configured summary model unavailable/,
    );
    assert.equal(h.states.at(-1).phase, "failed");
  }));
test("a lead-only custom summary cannot silently send a member summary to GPT", () =>
  using(async (h) => {
    fs.unlinkSync(path.join(h.directory, "member-compaction-summary.json"));
    fs.writeFileSync(
      path.join(h.directory, "compaction-summary.json"),
      JSON.stringify({ model: "summary-provider/flash" }),
    );
    const result = await h.compact();
    assert.equal(result.cancel, true);
    assert.equal(h.calls.length, 0);
    assert.match(h.notifications.join("\n"), /fallback is blocked/);
  }));

test("unconfigured member summary mode also uses current-model chunking while budget-only misconfiguration stays blocked", () =>
  using(async (h) => {
    fs.unlinkSync(path.join(h.directory, "member-compaction-summary.json"));
    h.ctx.model = {
      id: "flash",
      provider: "summary-provider",
      contextWindow: 64000,
      maxTokens: 4096,
      reasoning: false,
    };
    assert.ok((await h.compact()).compaction);
    assert.equal(h.calls[0].id, "flash");
    fs.mkdirSync(path.dirname(h.own), { recursive: true });
    fs.writeFileSync(h.own, JSON.stringify({ maxInputChars: 4000 }));
    const result = await h.compact();
    assert.equal(result.cancel, true);
    assert.equal(h.calls.length, 1);
    assert.match(h.notifications.join("\n"), /Summary model is missing/);
  }));

test(
  "real Pi member RPC compaction uses the shared independent route and recovers a truncated stream",
  { timeout: 20000 },
  async () => {
    const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "real-member-summary-"),
      ),
      trace = path.join(directory, "summary-trace.jsonl"),
      previousMode = process.env.MC_FIXTURE_SUMMARY;
    const { SessionManager } = await import(
      pathToFileURL(path.join(hostDir, "dist/index.js"))
    );
    const manager = SessionManager.create(
      directory,
      path.join(directory, "chat"),
    );
    manager.appendMessage({
      role: "user",
      content:
        "A completed read-only audit has exact evidence and pending files. ".repeat(
          100,
        ),
      timestamp: Date.now(),
    });
    manager.appendMessage({
      role: "assistant",
      api: "mission-fixture",
      provider: "mission-fixture",
      model: "model",
      timestamp: Date.now(),
      stopReason: "stop",
      content: [{ type: "text", text: "Earlier audit checkpoint retained" }],
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    manager.appendMessage({
      role: "user",
      content: "Continue the same read-only audit after compaction. ".repeat(
        30,
      ),
      timestamp: Date.now(),
    });
    const agentDir = path.join(directory, "agent");
    fs.mkdirSync(agentDir);
    fs.writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify({
        retry: { enabled: false },
        cacheWarming: "off",
        compaction: {
          enabled: true,
          keepRecentTokens: 100,
          reserveTokens: 1024,
        },
      }),
    );
    fs.writeFileSync(
      path.join(directory, "member-compaction-summary.json"),
      JSON.stringify({ model: "mission-fixture/summary" }),
    );
    let processChild;
    try {
      const cli = path.join(hostDir, "dist/bundle/cli.js");
      processChild = spawn(
        process.execPath,
        [
          cli,
          "--mode",
          "rpc",
          "--no-extensions",
          "--no-skills",
          "--no-context-files",
          "--no-prompt-templates",
          "--offline",
          "-e",
          path.resolve("tests/v2/offline-provider.ts"),
          "-e",
          path.resolve("extensions/mission-control/compaction.ts"),
          "--provider",
          "mission-fixture",
          "--model",
          "model",
          "--session",
          manager.getSessionFile(),
        ],
        {
          cwd: directory,
          env: {
            ...process.env,
            PI_CODING_AGENT_DIR: agentDir,
            MC_V2_MEMBER: JSON.stringify({
              directory,
              member: { id: "reader", name: "reader" },
            }),
            MC_FIXTURE_SUMMARY: "stream-once",
            MC_FIXTURE_SUMMARY_TRACE: trace,
          },
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      let buffer = "",
        errors = "";
      processChild.stderr.on("data", (chunk) => {
        errors = (errors + chunk).slice(-4000);
      });
      const response = await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(Error("RPC compaction timeout: " + errors)),
          15000,
        );
        processChild.on("error", reject);
        processChild.on("exit", (code) => {
          if (code !== 0) reject(Error("RPC exited: " + code + " " + errors));
        });
        processChild.stdout.on("data", (chunk) => {
          buffer += chunk;
          let newline;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            try {
              const value = JSON.parse(line);
              if (value.type === "response" && value.id === "compact-fixture") {
                clearTimeout(timer);
                resolve(value);
              }
            } catch {}
          }
        });
        processChild.stdin.write(
          JSON.stringify({ type: "compact", id: "compact-fixture" }) + "\n",
        );
      });
      assert.equal(response.success, true, JSON.stringify(response));
      const requests = fs
        .readFileSync(trace, "utf8")
        .trim()
        .split("\n")
        .map(JSON.parse);
      assert.equal(requests.length, 2);
      assert.ok(requests.every((r) => r.model === "summary"));
      const diagnostics = JSON.parse(
        fs.readFileSync(
          path.join(directory, "sessions/reader/compaction-diagnostics.json"),
          "utf8",
        ),
      );
      assert.equal(diagnostics.stage, "compact:success");
      assert.equal(diagnostics.retries, 1);
      assert.equal(diagnostics.model, "mission-fixture/summary");
    } finally {
      if (processChild && processChild.exitCode === null) {
        const exited = new Promise((resolve) =>
          processChild.once("exit", resolve),
        );
        processChild.stdin.end();
        await Promise.race([
          exited,
          new Promise((resolve) => setTimeout(resolve, 500)),
        ]);
        if (processChild.exitCode === null) processChild.kill();
        await exited;
      }
      if (previousMode === undefined) delete process.env.MC_FIXTURE_SUMMARY;
      else process.env.MC_FIXTURE_SUMMARY = previousMode;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);
