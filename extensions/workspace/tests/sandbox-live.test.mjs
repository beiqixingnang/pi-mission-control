import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {hostDir} from '../../../scripts/host.mjs';
const image=process.env.PI_SANDBOX_TEST_IMAGE;
const require=createRequire(path.join(hostDir,'package.json'));
const {createJiti}=await import(pathToFileURL(path.join(hostDir,'node_modules/jiti/lib/jiti.mjs')));
const jiti=createJiti(import.meta.url,{alias:{typebox:require.resolve('typebox'),'@earendil-works/pi-coding-agent':path.join(hostDir,'dist/index.js')}});
const {runSandbox}=await jiti.import(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../sandbox.ts'));
async function fixture(fn){const base=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'pi-podman-smoke-')));const root=path.join(base,'project'),extra=path.join(base,'reference');fs.mkdirSync(root);fs.mkdirSync(extra);fs.writeFileSync(path.join(root,'input.txt'),'INPUT');fs.writeFileSync(path.join(extra,'reference.txt'),'REFERENCE');const policy={root,access:'read-write',extraReadRoots:[extra],execution:'sandbox',sandbox:{engine:'podman',image,cpus:1,memoryMb:512,maxSeconds:30}};try{await fn(policy);}finally{fs.rmSync(base,{recursive:true,force:true});}}

test('local Podman executes Python in isolation, exports artifacts and keeps reference data read-only',{skip:!image,timeout:60000},()=>fixture(async policy=>{
 fs.mkdirSync(path.join(policy.root,'.pi'));fs.writeFileSync(path.join(policy.root,'.pi','fake-secret'),'SHOULD_NOT_COPY');
 const previous=process.env.PI_SANDBOX_TEST_SECRET;process.env.PI_SANDBOX_TEST_SECRET='HOST_SECRET_SENTINEL';
 let value;try{value=await runSandbox(policy,{command:`set -eu\ntest ! -e /workspace/.pi\ntest ! -e /mnt/c\ntest ! -e /var/run/docker.sock\nif touch /reference/0/forbidden 2>/dev/null; then exit 8; fi\npython3 -c 'import os,json; assert "PI_SANDBOX_TEST_SECRET" not in os.environ; assert open("input.txt").read()=="INPUT"; assert open("/reference/0/reference.txt").read()=="REFERENCE"; json.dump({"verified":True},open("result.json","w"))'\npython3 --version`,timeoutSeconds:20});}finally{if(previous===undefined)delete process.env.PI_SANDBOX_TEST_SECRET;else process.env.PI_SANDBOX_TEST_SECRET=previous;}
 assert.equal(value.ok,true,JSON.stringify(value));assert.equal(value.containerStopped,true,JSON.stringify(value));assert.deepEqual(JSON.parse(fs.readFileSync(path.join(policy.root,'result.json'),'utf8')),{verified:true});assert.ok(fs.existsSync(value.logPath));assert.ok(fs.existsSync(value.receiptPath));assert.equal(fs.existsSync(path.join(policy.extraReadRoots[0],'forbidden')),false);
}));

test('local hardware image runs Yosys and Verilator on a generated minimal module',{skip:!image,timeout:60000},()=>fixture(async policy=>{
 fs.writeFileSync(path.join(policy.root,'smoke.v'),'module smoke(input wire a, output wire y); assign y = a; endmodule\n');
 const value=await runSandbox(policy,{command:`set -eu\nyosys -Q -T -p 'read_verilog smoke.v; hierarchy -top smoke; proc; check' > yosys.log\nverilator --lint-only --top-module smoke smoke.v > verilator.log 2>&1\npython3 -c 'print("HARDWARE_TOOLCHAIN_OK")'`,timeoutSeconds:20});
 assert.equal(value.ok,true,JSON.stringify(value));assert.equal(value.containerStopped,true);assert.match(value.output,/HARDWARE_TOOLCHAIN_OK/);assert.ok(fs.existsSync(path.join(policy.root,'yosys.log')));assert.ok(fs.existsSync(path.join(policy.root,'verilator.log')));
}));

test('local Podman process timeout stops its container and leaves a receipt and partial log',{skip:!image,timeout:60000},()=>fixture(async policy=>{
 const value=await runSandbox(policy,{command:'echo BEFORE_TIMEOUT; sleep 30 & wait',timeoutSeconds:1});assert.equal(value.ok,false);assert.equal(value.timedOut,true,JSON.stringify(value));assert.equal(value.containerStopped,true,JSON.stringify(value));assert.match(fs.readFileSync(value.logPath,'utf8'),/BEFORE_TIMEOUT/);assert.equal(JSON.parse(fs.readFileSync(value.receiptPath,'utf8')).timedOut,true);
}));

test('local Podman cancellation stops only this run and retains recovery metadata',{skip:!image,timeout:60000},()=>fixture(async policy=>{
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),5000);
 try{const value=await runSandbox(policy,{command:'echo BEFORE_CANCEL; sleep 30 & wait',timeoutSeconds:20},controller.signal);assert.equal(value.cancelled,true,JSON.stringify(value));assert.equal(value.containerStopped,true,JSON.stringify(value));assert.ok(fs.existsSync(value.receiptPath));assert.ok(fs.existsSync(value.logPath));}finally{clearTimeout(timer);}
}));
