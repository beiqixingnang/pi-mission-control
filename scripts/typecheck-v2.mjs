import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
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
// Resolve relative includes from the project root on every platform and verify
// that the runtime and extension entry points really participate in the check.
const config = ts.parseJsonConfigFileContent(
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
      "runtime/**/*.ts",
      "extensions/mission-control/**/*.ts",
      "extensions/workspace/policy.ts",
      "extensions/workspace/sandbox.ts",
    ],
  },
  ts.sys,
  root,
);
const selected = new Set(config.fileNames.map((file) => path.resolve(file)));
for (const file of [
  "runtime/kernel.ts",
  "extensions/mission-control/index.ts",
  "extensions/mission-control/member.ts",
  "extensions/mission-control/viewer.ts",
  "extensions/mission-control/compaction.ts",
]) {
  if (!selected.has(path.resolve(root, file)))
    throw new Error(`Typecheck did not select required source: ${file}`);
}
const program = ts.createProgram(config.fileNames, config.options);
const diagnostics = [...config.errors, ...ts.getPreEmitDiagnostics(program)];
if (diagnostics.length) {
  console.error(
    ts.formatDiagnostics(diagnostics, {
      getCanonicalFileName: (file) => file,
      getCurrentDirectory: () => root,
      getNewLine: () => "\n",
    }),
  );
  process.exitCode = 1;
} else {
  console.log(
    `Typechecked ${config.fileNames.length} source files against Pi ${hostDir}`,
  );
}
