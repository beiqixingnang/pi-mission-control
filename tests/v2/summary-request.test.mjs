import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  requestSummary,
  summaryFailureKind,
  summaryRetryDelay,
} from "../../runtime/summary-request.ts";
import { summarizeChunks } from "../../runtime/summarize.ts";
const success = {
  stopReason: "stop",
  content: [
    {
      type: "text",
      text: "Complete factual checkpoint with retained evidence",
    },
  ],
};
const streamError =
  "OpenAI Responses stream ended before a terminal response event";

test("summary retries distinguish rate limits and truncated transports from permanent errors", () => {
  assert.equal(summaryFailureKind(streamError), "transport");
  assert.equal(
    summaryFailureKind("429 Too many requests retry-after: 12"),
    "rate_limit",
  );
  assert.equal(
    summaryRetryDelay("429 retry-after: 12", "rate_limit", 1),
    12000,
  );
  for (const error of [
    "401 invalid API key",
    "403 permission denied",
    "Configured summary model unavailable",
    "Your input exceeds the context window of this model",
    "Response incomplete: length",
    "Content filter",
  ])
    assert.equal(summaryFailureKind(error), undefined, error);
});
test("bounded transient retries share one allowance across summary requests and never accept partial output", async () => {
  const budget = { remaining: 2, used: 0 },
    events = [];
  let calls = 0;
  const result = await requestSummary(
    async () => {
      calls++;
      return calls < 3
        ? {
            stopReason: "error",
            errorMessage: calls === 1 ? "429 retry-after: 0" : streamError,
            content: [{ type: "text", text: "PARTIAL_MUST_NOT_SURVIVE" }],
          }
        : success;
    },
    { budget, onRetry: (e) => events.push(e), wait: async () => {} },
  );
  assert.equal(result, success);
  assert.equal(calls, 3);
  assert.equal(budget.remaining, 0);
  assert.deepEqual(
    events.map((e) => e.kind),
    ["rate_limit", "transport"],
  );
  const failed = await requestSummary(
    async () => ({
      stopReason: "error",
      errorMessage: streamError,
      content: [],
    }),
    {
      budget,
      wait: async () => {
        throw Error("No retry budget remains");
      },
    },
  );
  assert.equal(failed.stopReason, "error");
  assert.equal(budget.used, 2);
});
test("a user cancellation immediately aborts summary backoff without another request", async () => {
  const controller = new AbortController(),
    budget = { remaining: 2, used: 0 };
  let calls = 0;
  await assert.rejects(
    requestSummary(
      async () => {
        calls++;
        return { stopReason: "error", errorMessage: streamError, content: [] };
      },
      {
        budget,
        signal: controller.signal,
        onRetry: () => controller.abort(new Error("USER_CANCELLED_SUMMARY")),
      },
    ),
    /USER_CANCELLED_SUMMARY/,
  );
  assert.equal(calls, 1);
});
test("a server Retry-After longer than the automatic wait cap never causes an early retry", async () => {
  const budget = { remaining: 2, used: 0 };
  let calls = 0;
  const response = await requestSummary(
    async () => {
      calls++;
      return {
        stopReason: "error",
        errorMessage: "429 retry-after: 120",
        content: [],
      };
    },
    {
      budget,
      wait: async () => {
        throw Error("Must not shorten the server cooldown");
      },
    },
  );
  assert.equal(response.stopReason, "error");
  assert.equal(calls, 1);
  assert.equal(
    summaryRetryDelay("429 retry-after: 120", "rate_limit", 1),
    120000,
  );
  assert.equal(budget.used, 0);
});
test("a hung summary is cancelled by its own deadline and cannot hold the compaction forever", async () => {
  const signals = [],
    budget = { remaining: 1, used: 0 };
  await assert.rejects(
    requestSummary(
      async (signal) => {
        signals.push(signal);
        return new Promise(() => {});
      },
      { budget, timeoutMs: 15, wait: async () => {} },
    ),
    /timed out after 15ms/,
  );
  assert.equal(signals.length, 2);
  assert.ok(signals.every((signal) => signal.aborted));
});
test("stream failure resumes cached chunks and retries only within the compaction-wide budget", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "summary-stream-cache-"),
  );
  let calls = 0;
  const options = {
    model: "separate-summary/flash",
    directory,
    maxInputChars: 1600,
    maxOutputChars: 300,
    wait: async () => {},
    complete: async () => {
      calls++;
      return calls % 2
        ? { stopReason: "error", errorMessage: streamError, content: [] }
        : success;
    },
  };
  try {
    await assert.rejects(
      summarizeChunks(["public evidence ".repeat(400)], options),
      /terminal response event/,
    );
    const retained = fs
      .readdirSync(directory)
      .filter((n) => n.endsWith(".txt"));
    assert.ok(retained.length > 0);
    const before = calls;
    const progress = [];
    await summarizeChunks(["public evidence ".repeat(400)], {
      ...options,
      complete: async () => {
        calls++;
        return success;
      },
      onProgress: (event) => progress.push(event),
    });
    assert.ok(progress.some((event) => event.cacheHits > 0));
    assert.ok(calls - before < 8);
    assert.ok(
      fs
        .readdirSync(directory)
        .filter((n) => n.endsWith(".txt"))
        .every(
          (n) =>
            !fs
              .readFileSync(path.join(directory, n), "utf8")
              .includes("PARTIAL"),
        ),
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test("summary input overflow is repaired with bounded subdivision instead of repeating an oversized request", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "summary-input-overflow-"),
  );
  let calls = 0;
  try {
    const result = await summarizeChunks(["data ".repeat(250)], {
      directory,
      model: "summary/flash",
      maxInputChars: 2200,
      maxOutputChars: 300,
      complete: async (prompt) => {
        calls++;
        return prompt.length > 1400
          ? {
              stopReason: "error",
              errorMessage:
                "Your input exceeds the context window of this model",
              content: [],
            }
          : success;
      },
    });
    assert.equal(result, success.content[0].text);
    assert.ok(calls >= 3 && calls <= 6);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test("persistent transport failure shrinks only the failed block once and reuses completed chunk work", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "summary-transport-shrink-"),
  );
  let calls = 0;
  const progress = [];
  try {
    const result = await summarizeChunks(["evidence ".repeat(230)], {
      directory,
      model: "summary/flash",
      maxInputChars: 3000,
      maxOutputChars: 300,
      wait: async () => {},
      onProgress: (event) => progress.push(event),
      complete: async (prompt) => {
        calls++;
        return prompt.length > 1800
          ? { stopReason: "error", errorMessage: streamError, content: [] }
          : success;
      },
    });
    assert.equal(result, success.content[0].text);
    assert.equal(progress.filter((event) => event.stage === "split").length, 1);
    assert.ok(calls >= 4 && calls <= 6);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
