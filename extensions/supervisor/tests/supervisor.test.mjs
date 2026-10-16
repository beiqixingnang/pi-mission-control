import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

const here = path.dirname(fileURLToPath(import.meta.url));
import {hostDir} from '../../../scripts/host.mjs';
const packageDir = hostDir;
const {loadExtensions, createExtensionRuntime} = await import(pathToFileURL(path.join(packageDir, 'dist/core/extensions/loader.js')));
const {createEventBus} = await import(pathToFileURL(path.join(packageDir, 'dist/core/event-bus.js')));

async function harness() {
  const entries = [];
  const sent = [];
  const notices = [];
  const bus = createEventBus();
  const runtime = createExtensionRuntime();
  const state = {idle: true, queued: false};
  runtime.appendEntry = (customType, data) => entries.push({type: 'custom', customType, data: structuredClone(data)});
  // Simulate Pi: a triggerTurn message starts a turn, so the session is busy
  // until the test explicitly settles it with agent_end.
  runtime.sendMessage = (message, options) => {
    sent.push({message: structuredClone(message), options});
    if (options?.triggerTurn) state.idle = false;
  };
  const loaded = await loadExtensions([path.resolve(here, '../index.ts')], process.cwd(), bus, runtime);
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  const ctx = {
    mode: 'rpc',
    cwd: process.cwd(),
    isIdle: () => state.idle,
    hasPendingMessages: () => state.queued,
    sessionManager: {getBranch: () => entries},
    ui: {notify: (...args) => notices.push(args), setStatus: () => {}},
  };
  const emit = async (name, event = {}) => {
    let result;
    for (const handler of extension.handlers.get(name) || []) result = await handler({type: name, ...event}, ctx);
    return result;
  };
  const command = args => extension.commands.get('supervisor').handler(args, ctx);
  const tool = (name, params = {}) => extension.tools.get(name).definition.execute('test', params, undefined, undefined, ctx);
  const goal = value => entries.push({type: 'custom', customType: 'goal-state', data: value});
  await emit('session_start', {reason: 'startup'});
  return {entries, sent, notices, bus, state, emit, command, tool, goal, close: () => emit('session_shutdown', {reason: 'quit'})};
}

async function withHarness(fn) {
  const h = await harness();
  try {
    await fn(h);
  } finally {
    await h.close();
  }
}

test('idle by default: no wake even with an active goal and pending jobs', async () => withHarness(async h => {
  h.goal({status: 'running', objective: 'ship it'});
  h.bus.emit('team:job-start', {id: 'a', member: 'alice'});
  await delay(30);
  assert.equal(h.sent.length, 0);
}));

test('enabled supervisor wakes once and never overlaps an outstanding check turn', async () => withHarness(async h => {
  await h.command('on');
  h.goal({status: 'running', objective: 'ship it'});
  h.bus.emit('team:job-start', {id: 'a', member: 'alice'});
  await delay(30);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].options.triggerTurn, true);
  assert.equal(h.sent[0].options.deliverAs, 'followUp');
  assert.equal(h.sent[0].message.customType, 'supervisor-check');
  assert.match(h.sent[0].message.content, /1 team job/);
  // Busy main model: a second work signal must not queue another check.
  h.bus.emit('team:job-start', {id: 'b', member: 'bob'});
  await delay(30);
  assert.equal(h.sent.length, 1);
}));

test('goal state is read from session entries; paused goals alone never wake', async () => withHarness(async h => {
  await h.command('on 1');
  h.goal({status: 'paused'});
  h.bus.emit('goal:state', {});
  await delay(30);
  assert.equal(h.sent.length, 0);
  h.goal({status: 'waiting'});
  h.bus.emit('goal:state', {});
  await delay(1100);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].message.content, /Goal waiting/);
}));

test('session shutdown permanently stops the timer', async () => withHarness(async h => {
  await h.command('on');
  await h.close();
  h.state.idle = true;
  h.bus.emit('team:job-start', {id: 'a'});
  h.bus.emit('goal:state', {});
  await delay(30);
  assert.equal(h.sent.length, 0);
}));

test('provider errors schedule one bounded recovery only while work is active', async () => withHarness(async h => {
  await h.command('on');
  h.state.idle = true;
  await h.emit('agent_end', {outcome: 'error', error: 'no work error'});
  await delay(30);
  assert.equal(h.sent.length, 0, 'no recovery without active work');
  h.bus.emit('team:job-start', {id: 'a'});
  await delay(30);
  assert.equal(h.sent.length, 1);
  h.sent.length = 0;
  h.state.idle = true;
  await h.emit('agent_end', {outcome: 'error', error: 'provider down'});
  await delay(40);
  assert.equal(h.sent.length, 0, 'recovery is debounced');
  await delay(3100);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].message.content, /provider down/);
}));

test('finished team jobs clear the work gate', async () => withHarness(async h => {
  await h.command('on');
  h.bus.emit('team:job-start', {id: 'a'});
  await delay(30);
  assert.equal(h.sent.length, 1);
  h.sent.length = 0;
  h.state.idle = true;
  await h.emit('agent_end', {outcome: 'completed'});
  h.bus.emit('team:job-end', {id: 'a'});
  h.bus.emit('goal:state', {});
  await delay(30);
  assert.equal(h.sent.length, 0);
}));

test('model control tool changes supervisor state and validates interval', async () => withHarness(async h => {
  const status = await h.tool('supervisor_control', {action: 'status'}); assert.match(status.content[0].text, /Supervisor: off/);
  await h.tool('supervisor_control', {action: 'on', seconds: 2});
  assert.match((await h.tool('supervisor_control', {action: 'status'})).content[0].text, /interval 2s/);
  assert.equal((await h.tool('supervisor_control', {action: 'interval', seconds: 0.5})).isError, true);
  await h.tool('supervisor_control', {action: 'off'});
  assert.match((await h.tool('supervisor_control', {action: 'status'})).content[0].text, /Supervisor: off/);
}));
test('interval configuration is validated and reported', async () => withHarness(async h => {
  await h.command('interval 0.5');
  assert.match(String(h.notices.at(-1)[0]), /between/);
  await h.command('interval 2');
  await h.command('status');
  assert.match(String(h.notices.at(-1)[0]), /interval 2s/);
  await h.command('on');
  await h.command('off');
  await h.command('status');
  assert.match(String(h.notices.at(-1)[0]), /Supervisor: off/);
}));
