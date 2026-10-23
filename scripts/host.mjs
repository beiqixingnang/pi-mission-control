import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
const candidates = [];
if (process.env.PI_TEST_PACKAGE_DIR)
  candidates.push(process.env.PI_TEST_PACKAGE_DIR);
try {
  candidates.push(
    path.dirname(
      createRequire(import.meta.url).resolve(
        "@earendil-works/pi-coding-agent/package.json",
      ),
    ),
  );
} catch {}
if (process.env.APPDATA && process.platform === "win32")
  candidates.push(
    path.join(
      process.env.APPDATA,
      "npm/node_modules/@earendil-works/pi-coding-agent",
    ),
  );
if (
  !candidates.some((candidate) =>
    fs.existsSync(path.join(candidate, "dist/index.js")),
  )
) {
  try {
    const globalRoot = execFileSync("npm", ["root", "-g"], {
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
    }).trim();
    candidates.push(path.join(globalRoot, "@earendil-works/pi-coding-agent"));
  } catch {}
}
export const hostDir = candidates.find((candidate) =>
  fs.existsSync(path.join(candidate, "dist/index.js")),
);
if (!hostDir)
  throw new Error(
    "Pi installation not found. Set PI_TEST_PACKAGE_DIR to the installed @earendil-works/pi-coding-agent directory.",
  );
export const hostVersion = JSON.parse(
  fs.readFileSync(path.join(hostDir, "package.json"), "utf8"),
).version;
const version = /^(\d+)\.(\d+)\.(\d+)$/.exec(hostVersion);
if (!version || Number(version[1]) !== 1 || Number(version[2]) < 4)
  throw new Error(
    `Pi >=1.4.0 <2 is required; found ${hostVersion} at ${hostDir}. Upgrade this host or point PI_TEST_PACKAGE_DIR to Pi1.4.0.`,
  );
