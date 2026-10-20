import test from "node:test";
import assert from "node:assert/strict";
import { fetchPage, resolveWebFetchPolicy } from "../../runtime/web.ts";
import { resolveSettings } from "../../runtime/types.ts";
const policy = {
  trustedLocalHosts: ["github.com", "raw.githubusercontent.com"],
  useSystemCa: true,
};
const local = async () => [{ address: "127.0.0.1", family: 4 }];
test("an exact trusted HTTPS accelerator route is pinned and retains certificate verification", async () => {
  let calls = 0;
  const result = await fetchPage(
    "https://github.com/project",
    undefined,
    undefined,
    policy,
    {
      lookup: local,
      request: async (url, addresses, signal, selected) => {
        calls++;
        assert.equal(url.hostname, "github.com");
        assert.equal(addresses[0].address, "127.0.0.1");
        assert.equal(selected.useSystemCa, true);
        assert.ok(signal);
        return new Response("public source");
      },
    },
  );
  assert.equal(calls, 1);
  assert.equal(result.text, "public source");
});
test("accelerator compatibility cannot authorize local URLs, extra ports, LANs or redirects", async () => {
  for (const url of [
    "https://127.0.0.1/",
    "https://localhost/",
    "https://github.com:8443/",
    "http://github.com/",
    "https://other.example/",
  ]) {
    await assert.rejects(
      fetchPage(url, undefined, undefined, policy, {
        lookup: local,
        request: async () => {
          throw Error("must not connect");
        },
      }),
      /Private\/local/,
    );
  }
  await assert.rejects(
    fetchPage("https://github.com/", undefined, undefined, policy, {
      lookup: async () => [{ address: "192.168.1.10" }],
      request: async () => {
        throw Error("must not connect");
      },
    }),
    /Private\/local/,
  );
  let calls = 0;
  await assert.rejects(
    fetchPage("https://github.com/", undefined, undefined, policy, {
      lookup: local,
      request: async () => {
        calls++;
        return new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/metadata" },
        });
      },
    }),
    /Private\/local/,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    fetchPage(
      "https://github.com/",
      undefined,
      undefined,
      {},
      { lookup: local },
    ),
    /resolved to 127.0.0.1/,
  );
});
test("invalid policies and untrusted certificates produce explicit diagnostics", async () => {
  for (const host of [
    "*",
    "*.github.com",
    "localhost",
    "127.0.0.1",
    "github.com/path",
    "evil.local",
  ])
    assert.throws(
      () => resolveWebFetchPolicy({ trustedLocalHosts: [host] }),
      /Invalid webFetch/,
    );
  assert.throws(
    () => resolveSettings({ webFetch: { useSystemCa: "yes" } }),
    /Invalid webFetch/,
  );
  await assert.rejects(
    fetchPage("https://github.com/", undefined, undefined, policy, {
      lookup: local,
      request: async () => {
        throw Object.assign(Error("self signed"), {
          code: "SELF_SIGNED_CERT_IN_CHAIN",
        });
      },
    }),
    /System trust was enabled/,
  );
});
