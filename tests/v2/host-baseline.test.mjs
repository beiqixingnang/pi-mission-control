import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

test("verification refuses a stale Pi host instead of silently testing against 1.3", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mc-host-baseline-"));
  try {
    fs.mkdirSync(path.join(directory, "dist"));
    fs.writeFileSync(path.join(directory, "dist/index.js"), "export {};\n");
    for (const version of ["1.3.0", "1.4.0", "2.0.0"]) {
      fs.writeFileSync(
        path.join(directory, "package.json"),
        JSON.stringify({ version }),
      );
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import {hostVersion} from ${JSON.stringify(pathToFileURL(path.resolve("scripts/host.mjs")).href)}; console.log(hostVersion)`,
        ],
        {
          env: { ...process.env, PI_TEST_PACKAGE_DIR: directory },
          encoding: "utf8",
          windowsHide: true,
        },
      );
      if (version === "1.4.0") {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout.trim(), version);
      } else {
        assert.equal(result.status, 1);
        assert.match(result.stderr, /Pi >=1\.4\.0 <2 is required/);
        assert.match(
          result.stderr,
          new RegExp("found " + version.replaceAll(".", "\\.")),
        );
      }
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
