import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { hostDir } from "../../../scripts/host.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = hostDir;
const require = createRequire(path.join(pkg, "package.json"));
const { createJiti } = await import(pathToFileURL(path.join(pkg, "node_modules/jiti/lib/jiti.mjs")));
const jiti = createJiti(import.meta.url, { alias: { typebox: require.resolve("typebox"), "@earendil-works/pi-coding-agent": path.join(pkg, "dist/index.js") } });
const { probeSandbox, runSandbox, inspectSandboxRun, validateSandboxExportPath } = await jiti.import(path.resolve(here, "../sandbox.ts"));

async function fixture(fn) {
	const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-sandbox-test-")));
	const root = path.join(base, "workspace");
	const extra = path.join(base, "reference");
	const outside = path.join(base, "outside");
	await Promise.all([fs.mkdir(root), fs.mkdir(extra), fs.mkdir(outside)]);
	try { await fn({ base, root, extra, outside }); }
	finally { await fs.rm(base, { recursive: true, force: true }); }
}

const localImage = "a".repeat(64);


test("probe rejects an unconfigured engine without invoking a host fallback", async () => {
	const result = await probeSandbox({ engine: "docker", image: "latest" });
	assert.equal(result.available, false);
	assert.match(result.error, /podman|engine/i);
});

test("run validation rejects disabled execution, unsafe resources, and cwd escapes", async () => fixture(async ({ root }) => {
	const base = { root, access: "read-only", extraReadRoots: [], sandbox: { engine: "podman", image: localImage } };
	await assert.rejects(runSandbox({ ...base, execution: "disabled" }, { command: "true" }), /not enabled/i);
	await assert.rejects(runSandbox({ ...base, execution: "sandbox" }, { command: "true", cwd: "../" }), /cwd must be inside/i);
	await assert.rejects(runSandbox({ ...base, execution: "sandbox", sandbox: { ...base.sandbox, memoryMb: 1 } }, { command: "true" }), /memoryMb/i);
	await assert.rejects(runSandbox({ ...base, execution: "sandbox", sandbox: { ...base.sandbox, maxSeconds: 3 } }, { command: "true", timeoutSeconds: 4 }), /timeoutSeconds.*maxSeconds|maximum/i);
	await assert.rejects(runSandbox({ ...base, execution: "sandbox" }, { command: "true", timeoutSeconds: 0 }), /timeoutSeconds/i);
}));

test("root, reference, and cwd links are rejected before Podman starts", async () => fixture(async ({ root, extra, outside }) => {
	const config = { engine: "podman", image: localImage };
	let linkedRoot;
	try {
		linkedRoot = path.join(outside, "workspace-link");
		await fs.symlink(root, linkedRoot, "junction");
		await assert.rejects(runSandbox({ root: linkedRoot, access: "read-only", extraReadRoots: [], execution: "sandbox", sandbox: config }, { command: "true" }), /symbolic link/i);
	} catch (cause) {
		if ((cause?.code || "") !== "EPERM" && (cause?.code || "") !== "EACCES") throw cause;
	}
	await fs.writeFile(path.join(root, "marker.txt"), "marker\n");
	try {
		await fs.symlink(outside, path.join(root, "escape"), "junction");
		await assert.rejects(runSandbox({ root, access: "read-only", extraReadRoots: [extra], execution: "sandbox", sandbox: config }, { command: "true", cwd: "escape" }), /existing directory without links/i);
	} catch (cause) {
		if ((cause?.code || "") !== "EPERM" && (cause?.code || "") !== "EACCES") throw cause;
	}
	await assert.rejects(runSandbox({ root, access: "read-only", extraReadRoots: [root], execution: "sandbox", sandbox: config }, { command: "true" }), /separate and non-overlapping/i);
}));


test("export path validation protects metadata and Windows aliases", async () => fixture(async ({ root }) => {
	assert.throws(() => validateSandboxExportPath(root, ".mission-control/receipt.json"), /protected/i);
	assert.throws(() => validateSandboxExportPath(root, ".pi/config.json"), /protected/i);
	if (process.platform === "win32") {
		for (const name of ["CON.txt", "file:stream", "PROGRA~1/x", "file. ", "C:relative"]) assert.throws(() => validateSandboxExportPath(root, name), /Invalid|WORKSPACE_DENIED|ambiguous/i);
	}
}));

test("status helper rejects arbitrary IDs and ignores forged workspace receipts", async () => fixture(async ({ root }) => {
	const policy = { root, access: "read-only", extraReadRoots: [], execution: "sandbox", sandbox: { engine: "podman", image: localImage } };
	await assert.rejects(inspectSandboxRun(policy, "../../etc"), /Invalid sandbox run ID/i);
	const runId = "11111111-1111-4111-8111-111111111111";
	const runDir = path.join(root, ".mission-control", "runs", runId);
	await fs.mkdir(runDir, { recursive: true });
	await fs.writeFile(path.join(runDir, "receipt.json"), JSON.stringify({ runId, workspaceSha256: "forged", state: "running" }));
	const status = await inspectSandboxRun(policy, runId);
	assert.equal(status.processState, "unknown");
	assert.match(status.error, /workspace\/run/i);
}));


test("malformed sandbox configuration reports unavailable without downloading", async () => {
	const result = await probeSandbox({ engine: "podman", image: "" });
	assert.equal(result.available, false);
	assert.match(result.error, /image/i);
});
