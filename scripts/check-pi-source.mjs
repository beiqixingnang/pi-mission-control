/** Read-only consistency check for the development reference, never loads it. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const metadata = JSON.parse(
  fs.readFileSync(path.join(root, "vendor/pi-source.json"), "utf8"),
);
const source = path.join(root, "vendor", metadata.snapshot);
if (metadata.version !== "1.4.0" || metadata.snapshot !== "pi-1.4.0")
  throw new Error("Expected the Pi1.4.0 source reference");
const entries = [];
function walk(directory, relative = "") {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const name = relative + entry.name,
      file = path.join(directory, entry.name);
    if (entry.isSymbolicLink() || entry.name === ".git")
      throw new Error("Unexpected source entry: " + name);
    if (entry.isDirectory()) walk(file, name + "/");
    else if (entry.isFile()) {
      const data = fs.readFileSync(file);
      const canonical = data.includes(0) || !isUtf8(data)
        ? data
        : Buffer.from(data.toString("utf8").replace(/\r\n/g, "\n"));
      entries.push(
        name +
          "\0" +
          createHash("sha256").update(canonical).digest("hex") +
          "\n",
      );
    } else throw new Error("Unexpected source entry: " + name);
  }
}
walk(source);
const digest = createHash("sha256")
  .update(entries.sort().join(""))
  .digest("hex");
if (
  entries.length !== metadata.fileCount ||
  digest !== metadata.normalizedTreeSha256
)
  throw new Error(
    "Pi source differs from the imported archive (text CRLF/LF normalized)",
  );
const version = JSON.parse(
  fs.readFileSync(
    path.join(source, "packages/coding-agent/package.json"),
    "utf8",
  ),
).version;
if (version !== metadata.version) throw new Error("Pi source version mismatch");
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
const lock = JSON.parse(
  fs.readFileSync(path.join(root, "package-lock.json"), "utf8"),
);
for (const [name, range] of Object.entries(manifest.peerDependencies))
  if (name.startsWith("@earendil-works/pi-") && range !== "^1.4.0")
    throw new Error("Outdated Pi peer range: " + name);
for (const [name, value] of Object.entries(lock.packages))
  if (
    /node_modules\/@earendil-works\/pi-[^/]+$/.test(name) &&
    value.version !== metadata.version
  )
    throw new Error("Outdated Pi lock entry: " + name);
console.log(
  JSON.stringify({
    version,
    commit: metadata.commit,
    files: entries.length,
    normalizedTreeSha256: digest,
  }),
);
