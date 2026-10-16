import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const command = process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : "npm";
const args = process.platform === "win32" ? ["/d", "/s", "/c", "npm root -g"] : ["root", "-g"];
const globalRoot = execFileSync(command, args, { encoding: "utf8" }).trim();
const piDir = path.join(globalRoot, "@earendil-works", "pi-coding-agent");
const entry = path.join(piDir, "dist", "index.js");
if (!fs.existsSync(entry)) {
	throw new Error(`Installed Pi host was not found at ${entry}. npm root -g returned ${globalRoot}`);
}

console.log(`Using Pi host: ${piDir}`);
if (process.env.GITHUB_ENV) {
	fs.appendFileSync(process.env.GITHUB_ENV, `PI_TEST_PACKAGE_DIR=${piDir}${process.platform === "win32" ? "\r\n" : "\n"}`);
}
