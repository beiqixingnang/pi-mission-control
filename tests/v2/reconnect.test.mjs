import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { hostDir } from "../../scripts/host.mjs";
import {
  reconnectPolicy,
  contextLimitError,
  waitForReconnect,
  providerFailureKind,
  compactionFailureKind,
} from "../../runtime/reconnect.ts";

test("compaction wrappers expose the nested failure without hiding genuine context or account errors", () => {
  for (const wrapper of [
    "",
    "Context overflow recovery failed: ",
    "Auto-compaction failed: ",
    "Context overflow recovery failed: Turn prefix summarization failed: ",
    "Context overflow recovery failed: Summarization failed: ",
    "Summary request was truncated after bounded subdivision: Error: Context overflow recovery failed: Summarization failed: ",
  ]) {
    assert.equal(
      compactionFailureKind(
        wrapper + "upstream_error: Upstream service temporarily unavailable",
      ),
      "transient",
    );
    assert.equal(
      compactionFailureKind(wrapper + "429 Too many requests"),
      "transient",
    );
    assert.equal(
      compactionFailureKind(
        wrapper + "Your input exceeds the context window of this model",
      ),
      "context",
    );
    assert.equal(
      compactionFailureKind(wrapper + "401 invalid API key"),
      "external",
    );
    assert.equal(
      compactionFailureKind(wrapper + "insufficient_quota"),
      "external",
    );
  }
  assert.equal(
    contextLimitError("Your input exceeds the context window of this model"),
    true,
  );
});
const { loadExtensions, createExtensionRuntime } = await import(
  pathToFileURL(path.join(hostDir, "dist/core/extensions/loader.js"))
);
const { createEventBus } = await import(
  pathToFileURL(path.join(hostDir, "dist/core/event-bus.js"))
);
async function harness(fn, options = {}) {
  const bus = createEventBus(),
    runtime = createExtensionRuntime();
  const loaded = await loadExtensions(
    [path.resolve("extensions/mission-control/reconnect.ts")],
    process.cwd(),
    bus,
    runtime,
  );
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0],
    controller = new AbortController();
  const original = process.env.MC_V2_RECONNECT;
  process.env.MC_V2_RECONNECT = JSON.stringify({
    enabled: true,
    maxRetries: 10,
    delayMs: 0,
    ...options,
  });
  const ctx = {
    cwd: process.cwd(),
    mode: "rpc",
    isProjectTrusted: () => false,
    hasPendingMessages: () => false,
    signal: controller.signal,
    ui: { notify() {}, setStatus() {} },
  };
  const emit = async (type, event = {}) => {
    let result;
    for (const handler of extension.handlers.get(type) ?? [])
      result = await handler({ type, ...event }, ctx);
    return result;
  };
  const fail = async (
    error = "custom station connection reset with no HTTP status",
  ) => {
    await emit("message_end", {
      message: { role: "assistant", stopReason: "error", errorMessage: error },
    });
    return emit("agent_before_settle", {
      entries: [],
      continue: false,
      outcome: "error",
    });
  };
  try {
    await emit("session_start");
    await fn({ emit, fail, ctx, controller, bus });
  } finally {
    await emit("session_shutdown");
    if (original === undefined) delete process.env.MC_V2_RECONNECT;
    else process.env.MC_V2_RECONNECT = original;
  }
}
test("reconnect defaults are ten retries at a fixed five seconds; invalid settings fail closed", () => {
  assert.deepEqual(reconnectPolicy(), {
    enabled: true,
    maxRetries: 10,
    delayMs: 5000,
  });
  assert.equal(reconnectPolicy({}, false).enabled, false);
  assert.throws(() => reconnectPolicy({ maxRetries: -1 }));
  assert.equal(contextLimitError("custom upstream selection failed"), false);
  assert.equal(contextLimitError("maximum context exceeded"), true);
});
test("custom gateway errors receive ten retries without a status-code whitelist", () =>
  harness(async (h) => {
    for (let i = 1; i <= 10; i++) {
      const result = await h.fail();
      assert.equal(result.continue, true);
      assert.equal(result.entries.at(-1).details.retry, i);
    }
    assert.equal(await h.fail(), undefined);
    await h.emit("message_end", {
      message: { role: "assistant", stopReason: "stop" },
    });
    assert.equal(
      (await h.fail("gateway vendor arbitrary error")).entries.at(-1).details
        .retry,
      1,
    );
  }));
test("native 502/429 failures count toward the same consecutive failure budget", () =>
  harness(async (h) => {
    for (let i = 0; i < 4; i++)
      await h.emit("message_end", {
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "502 Bad Gateway",
        },
      });
    const continued = await h.emit("agent_before_settle", {
      entries: [],
      continue: false,
      outcome: "error",
    });
    assert.equal(continued.entries.at(-1).details.retry, 4);
    for (let i = 0; i < 7; i++)
      await h.emit("message_end", {
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "429 Too Many Requests",
        },
      });
    assert.equal(
      await h.emit("agent_before_settle", {
        entries: [],
        continue: false,
        outcome: "error",
      }),
      undefined,
    );
  }));
test("abort, shutdown, user stop and pending user input cancel reconnect rather than replay work", async () => {
  for (const action of ["abort", "shutdown", "stop", "input"])
    await harness(
      async (h) => {
        const pending = h.fail();
        setTimeout(() => {
          if (action === "abort") h.controller.abort();
          else if (action === "shutdown") void h.emit("session_shutdown");
          else if (action === "stop")
            h.bus.emit("mission-control:interrupt", {});
          else h.ctx.hasPendingMessages = () => true;
        }, 5);
        assert.equal(await pending, undefined, action);
      },
      { delayMs: 30 },
    );
});
test("context overflow and tool failures are not mistaken for a network reconnect", () =>
  harness(async (h) => {
    assert.equal(await h.fail("context window exceeded"), undefined);
    assert.equal(
      await h.fail(
        "Your input exceeds the context window of this model. Please adjust your input and try again.",
      ),
      undefined,
    );
    assert.equal(
      await h.fail(
        "Requested token count exceeds the model's maximum context length of 131072 tokens",
      ),
      undefined,
    );
    assert.equal(await h.fail("context_length_exceeded"), undefined);
    assert.equal(
      contextLimitError("Rate limit: too many tokens per minute"),
      false,
    );
    assert.equal(
      await h.emit("agent_before_settle", {
        entries: [],
        continue: false,
        outcome: "completed",
      }),
      undefined,
    );
  }));
test("fixed reconnect delay is cancellable without waiting five seconds", async () => {
  const controller = new AbortController(),
    start = Date.now();
  const waiting = waitForReconnect(5000, controller.signal);
  controller.abort();
  assert.equal(await waiting, false);
  assert.ok(Date.now() - start < 1000);
});

test("provider-side aborted messages receive reconnect while the actual cancellation signal remains authoritative", () =>
  harness(async (h) => {
    await h.emit("message_end", {
      message: {
        role: "assistant",
        stopReason: "aborted",
        errorMessage: "This operation was aborted",
      },
    });
    const result = await h.emit("agent_before_settle", {
      entries: [],
      continue: false,
      outcome: "aborted",
    });
    assert.equal(result.continue, true);
    h.controller.abort();
    assert.equal(
      await h.emit("agent_before_settle", {
        entries: [],
        continue: false,
        outcome: "aborted",
      }),
      undefined,
    );
  }));

test("account and configuration errors are managed without repeating the same invalid request", () =>
  harness(async (h) => {
    for (const error of [
      "401 invalid API key",
      "403 permission denied",
      "429 insufficient_quota",
      "model fixture not found",
    ]) {
      assert.equal(providerFailureKind(error), "external");
      assert.equal(await h.fail(error), undefined, error);
    }
    assert.equal(
      providerFailureKind("This operation was aborted"),
      "transient",
    );
    assert.equal(
      providerFailureKind("subscription_sharing_usage_unavailable"),
      "transient",
    );
    assert.equal(providerFailureKind("context window exceeded"), "context");
  }));
