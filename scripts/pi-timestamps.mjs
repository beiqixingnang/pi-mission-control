import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { hostDir } from "./host.mjs";
import { MARKER, patchPiTimestampFile } from "./lib/pi-timestamp-patch.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const digest = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");
const installationId = digest(fs.realpathSync(hostDir)).slice(0, 16);
const backupBase = path.join(
  root,
  ".reference/pi-timestamp-adapter",
  installationId,
);
const recordFile = path.join(backupBase, "active.json");
function replaceFile(target, value) {
  const temporary = target + ".mc-time-" + crypto.randomUUID();
  fs.writeFileSync(temporary, value, {
    flag: "wx",
    mode: fs.statSync(target).mode,
  });
  fs.renameSync(temporary, target);
}
const mode = process.argv[2] ?? "status";
const version = JSON.parse(
  fs.readFileSync(path.join(hostDir, "package.json"), "utf8"),
).version;
if (!["status", "apply", "restore"].includes(mode))
  throw new Error("Use status, apply or restore");
const base = "dist/modes/interactive/";
const targets = [
  "components/user-message.js",
  "components/assistant-message.js",
  "components/tool-execution.js",
  "components/custom-message.js",
  "interactive-mode.js",
].map((name) => base + name);
const chunks = fs
  .readdirSync(path.join(hostDir, "dist/bundle/chunks"))
  .filter(
    (name) =>
      name.endsWith(".js") &&
      fs
        .readFileSync(path.join(hostDir, "dist/bundle/chunks", name), "utf8")
        .includes("UserMessageComponent=class"),
  );
if (chunks.length !== 1)
  throw new Error("Unsupported Pi bundle shape; no files changed");
targets.push("dist/bundle/chunks/" + chunks[0]);
const files = targets.map((relative) => ({
  relative,
  target: path.join(hostDir, relative),
  before: fs.readFileSync(path.join(hostDir, relative), "utf8"),
}));
const adapted = files.filter((file) => file.before.includes(MARKER)).length;
if (mode === "status") {
  console.log(
    JSON.stringify(
      {
        hostDir,
        version,
        adaptedFiles: adapted,
        totalFiles: files.length,
        restartRequiredAfterApply: true,
      },
      null,
      2,
    ),
  );
} else if (mode === "apply") {
  if (version !== "1.3.0")
    throw new Error(
      `Adapter only audited for Pi1.3.0, found ${version}; no files changed`,
    );
  if (adapted === files.length) {
    console.log("Pi timestamp adapter already installed.");
  } else {
    if (adapted)
      throw new Error("Partial adapter found; inspect/restore before applying");
    for (const file of files)
      file.after = patchPiTimestampFile(file.relative, file.before);
    const backup = path.join(
      backupBase,
      new Date().toISOString().replace(/[:.]/g, "-"),
    );
    for (const file of files) {
      const destination = path.join(backup, file.relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, file.before);
    }
    const record = {
      version,
      hostDir,
      backup,
      files: files.map((file) => ({
        relative: file.relative,
        before: digest(file.before),
        after: digest(file.after),
      })),
    };
    fs.writeFileSync(recordFile, JSON.stringify(record, null, 2) + "\n");
    try {
      for (const file of files) {
        if (
          digest(fs.readFileSync(file.target, "utf8")) !== digest(file.before)
        )
          throw new Error(`Pi changed during adaptation: ${file.relative}`);
        replaceFile(file.target, file.after);
      }
    } catch (error) {
      for (const file of files) {
        if (digest(fs.readFileSync(file.target, "utf8")) === digest(file.after))
          replaceFile(file.target, file.before);
      }
      throw error;
    }
    console.log(
      JSON.stringify(
        { applied: files.length, version, backup, restartRequired: true },
        null,
        2,
      ),
    );
  }
} else {
  const legacyRecord = path.join(
    root,
    ".reference/pi-timestamp-adapter/active.json",
  );
  const record = JSON.parse(
    fs.readFileSync(
      fs.existsSync(recordFile) ? recordFile : legacyRecord,
      "utf8",
    ),
  );
  if (record.hostDir !== hostDir || record.version !== version)
    throw new Error("Pi installation changed; refusing to restore old files");
  const backupRoot =
    path.join(root, ".reference/pi-timestamp-adapter") + path.sep;
  if (
    !path.resolve(record.backup).startsWith(backupRoot) ||
    record.files.length !== targets.length ||
    new Set(record.files.map((file) => file.relative)).size !==
      targets.length ||
    record.files.some((file) => !targets.includes(file.relative))
  )
    throw new Error("Unexpected adapter backup manifest");
  for (const file of record.files) {
    const current = fs.readFileSync(path.join(hostDir, file.relative), "utf8");
    if (![file.before, file.after].includes(digest(current)))
      throw new Error(`Pi file changed since adaptation: ${file.relative}`);
    if (
      digest(
        fs.readFileSync(path.join(record.backup, file.relative), "utf8"),
      ) !== file.before
    )
      throw new Error("Backup checksum mismatch");
  }
  for (const file of record.files)
    replaceFile(
      path.join(hostDir, file.relative),
      fs.readFileSync(path.join(record.backup, file.relative)),
    );
  console.log("Original Pi files restored. Restart Pi to use them.");
}
