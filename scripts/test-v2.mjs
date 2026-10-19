import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { hostDir } from "./host.mjs";
// Windows hosted runners can expose TEMP through an 8.3 alias (RUNNER~1).
// Feed the same canonical paths to Pi, fixtures and the restricted file tools.
const agentDir = fs.realpathSync.native(
  fs.mkdtempSync(path.join(os.tmpdir(), "pi-mission-v2-tests-")),
);
fs.writeFileSync(
  path.join(agentDir, "settings.json"),
  JSON.stringify({ retry: { enabled: false }, cacheWarming: "off" }),
);
const requested = process.argv.slice(2);
const child = spawn(
  process.execPath,
  [
    "--unhandled-rejections=strict",
    "--experimental-strip-types",
    "--test",
    "--test-concurrency=1",
    ...(requested.length ? requested : ["tests/v2/*.test.mjs"]),
  ],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_TEST_PACKAGE_DIR: hostDir,
    },
    stdio: "inherit",
    windowsHide: true,
  },
);
child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
  fs.rmSync(agentDir, { recursive: true, force: true });
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
  fs.rmSync(agentDir, { recursive: true, force: true });
});
