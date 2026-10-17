import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { hostDir } from "./host.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  paths = {};
for (const name of [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-tui",
  "typebox",
]) {
  const directory =
    name === "@earendil-works/pi-coding-agent"
      ? hostDir
      : path.join(hostDir, "node_modules", name);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(directory, "package.json"), "utf8"),
  );
  paths[name] = [path.resolve(directory, manifest.types)];
}
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mc-v2-typecheck-")),
  config = path.join(directory, "tsconfig.json");
try {
  fs.writeFileSync(
    config,
    JSON.stringify(
      {
        compilerOptions: {
          noEmit: true,
          target: "ES2023",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          skipLibCheck: true,
          allowImportingTsExtensions: true,
          baseUrl: root,
          paths,
          typeRoots: [path.join(root, "node_modules/@types")],
        },
        include: [
          path.join(root, "runtime/**/*.ts"),
          path.join(root, "extensions/mission-control/**/*.ts"),
          path.join(root, "extensions/workspace/policy.ts"),
          path.join(root, "extensions/workspace/sandbox.ts"),
        ],
      },
      null,
      2,
    ),
  );
  const result = spawnSync(
    process.execPath,
    [path.join(root, "node_modules/typescript/bin/tsc"), "-p", config],
    { cwd: root, stdio: "inherit", windowsHide: true },
  );
  process.exitCode = result.status ?? 1;
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
