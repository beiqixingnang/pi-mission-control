import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

interface MissionWebOptions {
  cwd: string;
  htmlFile: string;
  sessionId: string;
  getSnapshot: () => unknown;
  onMessage: (
    text: string,
    options: { deliverAs?: "steer" | "followUp"; requestId: string },
  ) => unknown | Promise<unknown>;
  onAction?: (
    action: string,
    args: unknown,
    requestId: string,
  ) => unknown | Promise<unknown>;
  host?: string;
  port?: number;
}

const json = (value: unknown) => JSON.stringify(value);
async function readBody(req: http.IncomingMessage, max = 64 * 1024) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new Error("Request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
function cookieValue(req: http.IncomingMessage, name: string) {
  const header = req.headers.cookie ?? "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}
export async function openMissionWeb(options: MissionWebOptions) {
  const token = randomUUID();
  const cookie = `mission_web=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`;
  let html = await fs.readFile(path.resolve(options.htmlFile), "utf8");
  html = html.replace(
    "</head>",
    `<meta name="mission-session" content="${options.sessionId}"><meta name="mission-web" content="authenticated-local-preview"></head>`,
  );
  const authorized = (req: http.IncomingMessage) =>
    req.headers.authorization === `Bearer ${token}` ||
    cookieValue(req, "mission_web") === token;
  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url ?? "/", "http://mission.local");
    res.setHeader("cache-control", "no-store");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-content-type-options", "nosniff");
    try {
      if (requestUrl.pathname === "/" && req.method === "GET") {
        if (
          requestUrl.searchParams.get("token") === token &&
          !authorized(req)
        ) {
          res.setHeader("set-cookie", cookie);
          res.writeHead(302, { location: "/" }).end();
          return;
        }
        if (!authorized(req)) {
          res.writeHead(401).end("Open the URL printed by /mission web on");
          return;
        }
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(html);
        return;
      }
      if (!authorized(req)) {
        res.writeHead(401).end(json({ error: "Authentication required" }));
        return;
      }
      if (requestUrl.pathname === "/api/health" && req.method === "GET") {
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(json({ ok: true, sessionId: options.sessionId }));
        return;
      }
      if (requestUrl.pathname === "/api/session" && req.method === "GET") {
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(
          json({
            sessionId: options.sessionId,
            web: "same-process",
            snapshot: options.getSnapshot(),
          }),
        );
        return;
      }
      if (requestUrl.pathname === "/api/message" && req.method === "POST") {
        const body = JSON.parse(await readBody(req));
        const requestId =
          typeof body.requestId === "string" && body.requestId.trim()
            ? body.requestId
            : randomUUID();
        if (typeof body.text !== "string" || !body.text.trim())
          throw new Error("Message text is required");
        const result = await options.onMessage(body.text, {
          deliverAs:
            body.deliverAs === "steer" || body.deliverAs === "followUp"
              ? body.deliverAs
              : undefined,
          requestId,
        });
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(json({ ok: true, requestId, result }));
        return;
      }
      if (
        requestUrl.pathname === "/api/action" &&
        req.method === "POST" &&
        options.onAction
      ) {
        const body = JSON.parse(await readBody(req));
        if (typeof body.action !== "string" || !body.action.trim())
          throw new Error("Action is required");
        const requestId =
          typeof body.requestId === "string" && body.requestId.trim()
            ? body.requestId
            : randomUUID();
        const result = await options.onAction(
          body.action,
          body.args,
          requestId,
        );
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(json({ ok: true, requestId, result }));
        return;
      }
      res.writeHead(404).end(json({ error: "Not found" }));
    } catch (error) {
      res
        .writeHead(409)
        .end(
          json({ ok: false, error: String((error as Error).message ?? error) }),
        );
    }
  });
  const host = options.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://${host}:${address.port}/?token=${encodeURIComponent(token)}`,
    token,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
