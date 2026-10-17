/** Restore-only recovery for the withdrawn 2.0.7 Pi UI patch. No installer. */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { hostDir } from "./host.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const mode = process.argv[2] ?? "status";
if (!["status", "restore"].includes(mode))
  throw new Error(
    "The Pi patch installer has been removed. Only status or restore of the old 2.0.7 patch is supported.",
  );
const marker = "PI_MISSION_TIMESTAMP_ADAPTER_V1";
const backupRoot = path.join(root, ".reference/pi-timestamp-adapter");
const id = hash(fs.realpathSync(hostDir)).slice(0, 16);
const modern = path.join(backupRoot, id, "active.json"),
  legacy = path.join(backupRoot, "active.json");
const recordFile = fs.existsSync(modern)
  ? modern
  : fs.existsSync(legacy)
    ? legacy
    : undefined;
const record = recordFile
  ? JSON.parse(fs.readFileSync(recordFile, "utf8"))
  : undefined;
const fixed = [
  "user-message",
  "assistant-message",
  "tool-execution",
  "custom-message",
]
  .map((name) => `dist/modes/interactive/components/${name}.js`)
  .concat("dist/modes/interactive/interactive-mode.js");
const chunkDir = path.join(hostDir, "dist/bundle/chunks");
const chunks = fs.existsSync(chunkDir)
  ? fs
      .readdirSync(chunkDir)
      .filter((name) => /^chunk-[\w-]+\.js$/.test(name))
      .map((name) => "dist/bundle/chunks/" + name)
  : [];
const marked = [...fixed, ...chunks].filter(
  (relative) =>
    fs.existsSync(path.join(hostDir, relative)) &&
    fs.readFileSync(path.join(hostDir, relative), "utf8").includes(marker),
);
if (mode === "status") {
  console.log(
    JSON.stringify(
      {
        hostDir,
        patchedFiles: marked.length,
        installerAvailable: false,
        backupAvailable: record?.hostDir === hostDir,
      },
      null,
      2,
    ),
  );
} else if (!marked.length) {
  console.log(
    "Pi already has no Mission Control timestamp patch; no files changed.",
  );
} else {
  if (
    !record ||
    record.hostDir !== hostDir ||
    record.version !==
      JSON.parse(fs.readFileSync(path.join(hostDir, "package.json"), "utf8"))
        .version
  )
    throw new Error(
      "No matching backup for this Pi installation; no files changed.",
    );
  const backup = path.resolve(record.backup);
  const allowed = (relative) =>
    fixed.includes(relative) ||
    /^dist\/bundle\/chunks\/chunk-[\w-]+\.js$/.test(relative);
  if (
    !backup.startsWith(backupRoot + path.sep) ||
    record.files.length !== 6 ||
    new Set(record.files.map((file) => file.relative)).size !== 6 ||
    record.files.some((file) => !allowed(file.relative))
  )
    throw new Error("Unexpected recovery manifest; no files changed.");
  const plan = record.files.map((file) => {
    const target = path.join(hostDir, file.relative),
      original = fs.readFileSync(path.join(backup, file.relative)),
      current = fs.readFileSync(target);
    if (
      hash(original) !== file.before ||
      ![file.before, file.after].includes(hash(current))
    )
      throw new Error(
        `Pi or backup changed: ${file.relative}; no files changed.`,
      );
    return { ...file, target, original, currentHash: hash(current) };
  });
  for (const file of plan)
    if (file.currentHash !== file.before) {
      const temporary = file.target + ".mc-restore-" + crypto.randomUUID();
      fs.writeFileSync(temporary, file.original, {
        flag: "wx",
        mode: fs.statSync(file.target).mode,
      });
      fs.renameSync(temporary, file.target);
    }
  console.log(
    "Original Pi files restored. Restart Pi once to discard any old in-memory patch.",
  );
}
