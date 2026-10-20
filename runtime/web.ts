import dns from "node:dns/promises";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { Readable } from "node:stream";
import type { Settings } from "./types.ts";

export interface WebFetchPolicy {
  /** Explicit public HTTPS hostnames allowed through the user's loopback accelerator. */
  trustedLocalHosts?: string[];
  useSystemCa?: boolean;
}
export function resolveWebFetchPolicy(
  raw: WebFetchPolicy = {},
): WebFetchPolicy {
  if (
    (raw.useSystemCa !== undefined && typeof raw.useSystemCa !== "boolean") ||
    (raw.trustedLocalHosts !== undefined &&
      (!Array.isArray(raw.trustedLocalHosts) ||
        raw.trustedLocalHosts.length > 100 ||
        raw.trustedLocalHosts.some(
          (h) =>
            typeof h !== "string" ||
            !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(h) ||
            /(?:^|\.)(?:localhost|local|internal)$/.test(h) ||
            net.isIP(h),
        )))
  )
    throw Error(
      "Invalid webFetch policy: exact public hostnames and useSystemCa boolean required",
    );
  return {
    trustedLocalHosts: [...new Set(raw.trustedLocalHosts ?? [])],
    useSystemCa: raw.useSystemCa ?? false,
  };
}
interface WebFetchDependencies {
  lookup?: (
    host: string,
  ) => Promise<Array<{ address: string; family?: number }>>;
  request?: typeof pinnedPage;
}

async function boundedText(response: Response, max = 1024 * 1024) {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (Number(response.headers.get("content-length")) > max)
    throw new Error("Response exceeds size limit");
  const reader = response.body?.getReader();
  if (!reader) return "";
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > max) throw new Error("Response exceeds size limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString("utf8");
}
export function privateAddress(address: string) {
  const ip = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (net.isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  return (
    ip.startsWith("::") ||
    ip.startsWith("fc") ||
    ip.startsWith("fd") ||
    ip.startsWith("ff") ||
    ip.startsWith("fe8") ||
    ip.startsWith("fe9") ||
    ip.startsWith("fea") ||
    ip.startsWith("feb") ||
    ip.startsWith("2002:")
  );
}
function pinnedPage(
  url: URL,
  addresses: Array<{ address: string; family?: number }>,
  signal: AbortSignal,
  policy: WebFetchPolicy = {},
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const lookup: any = (_host: string, options: any, callback: any) => {
      const records = addresses.map((a) => ({
        address: a.address,
        family: a.family ?? net.isIP(a.address),
      }));
      if (options?.all) callback(null, records);
      else callback(null, records[0].address, records[0].family);
    };
    const certificates = policy.useSystemCa
      ? (() => {
          if (typeof tls.getCACertificates !== "function")
            throw Error(
              "System certificate support requires a newer Node.js runtime",
            );
          return [
            ...tls.getCACertificates("default"),
            ...tls.getCACertificates("system"),
          ];
        })()
      : undefined;
    const request = (url.protocol === "https:" ? https : http).request(
      url,
      {
        lookup,
        signal,
        ...(certificates ? { ca: certificates } : {}),
        headers: { "user-agent": "Pi-Mission-Control/2.0" },
      },
      (response) => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(response.headers))
          if (value !== undefined)
            headers.set(key, Array.isArray(value) ? value.join(", ") : value);
        try {
          const status = response.statusCode ?? 500;
          const noBody = [204, 205, 304].includes(status);
          if (noBody) response.resume();
          resolve(
            new Response(
              noBody
                ? null
                : (Readable.toWeb(response) as ReadableStream<Uint8Array>),
              { status, headers },
            ),
          );
        } catch (error) {
          response.destroy();
          reject(error);
        }
      },
    );
    request.once("error", reject);
    request.end();
  });
}
export async function fetchPage(
  url: string,
  signal?: AbortSignal,
  fetcher?: typeof fetch,
  options: WebFetchPolicy = {},
  dependencies: WebFetchDependencies = {},
) {
  const policy = resolveWebFetchPolicy(options);
  const deadline = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(20000)])
    : AbortSignal.timeout(20000);
  let target = new URL(url);
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (
      !["https:", "http:"].includes(target.protocol) ||
      target.username ||
      target.password
    )
      throw new Error(
        "Only public HTTP(S) pages without embedded credentials are allowed",
      );
    const host = target.hostname.replace(/^\[|\]$/g, "");
    const addresses = net.isIP(host)
      ? [{ address: host }]
      : await (dependencies.lookup?.(host) ?? dns.lookup(host, { all: true }));
    const privateTargets = addresses.filter((a) => privateAddress(a.address));
    const trustedLoopback =
      !net.isIP(host) &&
      policy.trustedLocalHosts?.includes(host) &&
      target.protocol === "https:" &&
      (!target.port || target.port === "443") &&
      privateTargets.length > 0 &&
      addresses.every((a) => a.address === "127.0.0.1" || a.address === "::1");
    if (!addresses.length || (privateTargets.length && !trustedLoopback))
      throw new Error(
        `Private/local network targets are not allowed by web_fetch: ${host} resolved to ${addresses.map((a) => a.address).join(", ") || "no address"}. Public hostnames mapped to loopback by an accelerator require an exact trustedLocalHosts entry; direct local URLs remain blocked.`,
      );
    let response: Response;
    try {
      response = fetcher
        ? await fetcher(target, { redirect: "manual", signal: deadline })
        : await (dependencies.request ?? pinnedPage)(
            target,
            addresses,
            deadline,
            policy,
          );
    } catch (error) {
      if (
        /UNABLE_TO_VERIFY|SELF_SIGNED|CERT_HAS_EXPIRED|unable to verify|self.signed/i.test(
          String((error as any)?.code) + String(error),
        )
      )
        throw Error(
          `TLS certificate verification failed for ${host}. ${policy.useSystemCa ? "System trust was enabled; inspect the accelerator certificate and its expiry." : "A trusted local accelerator may need webFetch.useSystemCa=true."} Original error: ${String(error)}`,
        );
      throw error;
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location) throw new Error("Redirect without destination");
      target = new URL(location, target);
      continue;
    }
    const body = await boundedText(response);
    const html = /html/i.test(response.headers.get("content-type") ?? "");
    const text = html
      ? body
          .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/g, " ")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/\s+/g, " ")
          .trim()
      : body;
    return {
      url: target.href,
      retrievedAt: new Date().toISOString(),
      text: text.slice(0, 32000),
      truncated: text.length > 32000,
    };
  }
  throw new Error("Too many redirects");
}
export async function searchWeb(
  query: string,
  settings: Pick<Settings, "searchProvider" | "searchUrl">,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  if (!query.trim() || query.length > 4000)
    throw new Error("Query must contain 1 to 4000 characters");
  const timeout = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(25000)])
    : AbortSignal.timeout(25000);
  let url: string, options: RequestInit;
  if (settings.searchProvider === "searxng") {
    if (!settings.searchUrl)
      throw new Error("Configure searchUrl for your SearXNG service");
    const u = new URL(settings.searchUrl);
    u.searchParams.set("q", query);
    u.searchParams.set("format", "json");
    url = u.href;
    options = { signal: timeout };
  } else if (settings.searchProvider === "brave") {
    const key = process.env.BRAVE_API_KEY;
    if (!key) throw new Error("BRAVE_API_KEY is required for Brave search");
    url =
      "https://api.search.brave.com/res/v1/web/search?q=" +
      encodeURIComponent(query) +
      "&count=8";
    options = { signal: timeout, headers: { "X-Subscription-Token": key } };
  } else {
    url = "https://mcp.exa.ai/mcp";
    options = {
      method: "POST",
      signal: timeout,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "web_search_exa",
          arguments: { query, numResults: 8, type: "auto" },
        },
      }),
    };
  }
  const response = await fetcher(url, options);
  let text = await boundedText(response);
  let data: any;
  try {
    if (/^data:/m.test(text)) {
      const records = text
        .split(/\r?\n/)
        .filter((x) => x.startsWith("data:"))
        .map((x) => x.slice(5).trim())
        .filter((x) => x && x !== "[DONE]")
        .map((x) => JSON.parse(x));
      data = records.find((x) => x.result || x.error) ?? records.at(-1);
    } else data = JSON.parse(text);
  } catch {
    throw new Error("Search service returned an invalid response");
  }
  if (data.error || data.result?.isError)
    throw new Error(
      "Search service failed: " +
        JSON.stringify(data.error ?? data.result.content).slice(0, 1000),
    );
  if (settings.searchProvider === "exa")
    text = (data.result?.content ?? [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n");
  else
    text = JSON.stringify(data.web?.results ?? data.results ?? data, null, 2);
  return {
    provider: settings.searchProvider,
    query,
    retrievedAt: new Date().toISOString(),
    content: text.slice(0, 24000),
    truncated: text.length > 24000,
  };
}
