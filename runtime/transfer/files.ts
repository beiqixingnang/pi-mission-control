import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { DatabaseSync } from "node:sqlite";

export interface TransferFile {
  path: string;
  size: number;
  sha256: string;
  mode: number;
  mtimeMs: number;
}
export async function digest(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
export function safeName(name: string) {
  if (
    typeof name !== "string" ||
    !name ||
    name.length > 4096 ||
    /[\\:\x00-\x1f]/.test(name) ||
    name.startsWith("/") ||
    name.split("/").some((s) => !s || s === "." || s === "..")
  )
    throw Error("Invalid transfer entry path: " + name);
  if (
    process.platform === "win32" &&
    name
      .split("/")
      .some(
        (s) =>
          /[<>"|?*]|[. ]$/.test(s) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s),
      )
  )
    throw Error("Transfer entry is not a valid Windows filename: " + name);
  return name;
}
export async function regularFile(root: string, name: string) {
  safeName(name);
  let current = root;
  for (const part of name.split("/")) {
    current = path.join(current, part);
    if ((await fsp.lstat(current)).isSymbolicLink())
      throw Error("Transfer symlinks are not accepted: " + name);
  }
  if (!(await fsp.stat(current)).isFile())
    throw Error("Transfer entry is not a regular file: " + name);
  return current;
}
export async function snapshotDatabase(source: string, target: string) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=5000");
    db.prepare("VACUUM INTO ?").run(target);
  } finally {
    db.close();
  }
}
export async function copyBounded(
  source: string,
  target: string,
  bytes?: number,
) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  if (bytes === 0) {
    await fsp.writeFile(target, "", { flag: "wx", mode: 0o600 });
    return;
  }
  await pipeline(
    fs.createReadStream(
      source,
      bytes === undefined ? {} : { start: 0, end: bytes - 1 },
    ),
    fs.createWriteStream(target, { flags: "wx", mode: 0o600 }),
  );
}
/** A live writer can append beyond the captured boundary; retain whole LF records only. */
export async function completeLogBytes(file: string, limit?: number) {
  const handle = await fsp.open(file, "r");
  try {
    let end = Math.min((await handle.stat()).size, limit ?? Infinity);
    while (end > 0) {
      const length = Math.min(end, 65536),
        buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, end - length);
      const at = buffer.subarray(0, bytesRead).lastIndexOf(10);
      if (at >= 0) return end - length + at + 1;
      end -= length;
    }
    throw Error("Session has no complete LF record: " + file);
  } finally {
    await handle.close();
  }
}
export async function logHeader(file: string) {
  const handle = await fsp.open(file, "r");
  try {
    const buffer = Buffer.alloc(65536),
      { bytesRead } = await handle.read(buffer, 0, buffer.length, 0),
      end = buffer.subarray(0, bytesRead).indexOf(10);
    if (end < 0) throw Error("Session header exceeds 64 KiB");
    const value = JSON.parse(
      buffer
        .subarray(0, end)
        .toString("utf8")
        .replace(/^\uFEFF/, ""),
    );
    if (
      value.type !== "session" ||
      typeof value.id !== "string" ||
      typeof value.cwd !== "string"
    )
      throw Error("Invalid session header");
    return value;
  } finally {
    await handle.close();
  }
}
export async function walk(root: string, relative = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await fsp.readdir(path.join(root, relative), {
    withFileTypes: true,
  })) {
    const name = relative ? relative + "/" + entry.name : entry.name;
    if (entry.isSymbolicLink())
      throw Error("Symbolic links require a separate workspace copy: " + name);
    if (entry.isDirectory()) files.push(...(await walk(root, name)));
    else if (entry.isFile()) files.push(name);
    else throw Error("Non-regular transfer entry: " + name);
  }
  return files;
}
