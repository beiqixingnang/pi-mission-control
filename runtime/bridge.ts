import http from "node:http";
import type { AddressInfo } from "node:net";

/** Loopback-only capability transport; caller identity comes from the token. */
export async function openBridge(
  handle: (token: string, request: unknown) => unknown,
) {
  const server = http.createServer(async (req, res) => {
    res.setHeader("content-type", "application/json; charset=utf-8");
    if (req.method !== "POST" || req.url !== "/") {
      res.writeHead(404).end();
      return;
    }
    const token = req.headers.authorization?.replace(/^Bearer /, "");
    if (!token) {
      res.writeHead(401).end('{"error":"Authentication required"}');
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 128 * 1024) {
          res.writeHead(413).end('{"error":"Request too large"}');
          req.destroy();
          return;
        }
        chunks.push(chunk);
      }
      const result = handle(
        token,
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
      );
      res.end(JSON.stringify({ ok: true, result }));
    } catch (error) {
      res.writeHead(409).end(
        JSON.stringify({
          ok: false,
          error: String((error as Error).message ?? error),
        }),
      );
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
