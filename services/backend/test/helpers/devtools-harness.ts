import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const origin = 'https://collect.linkx.ink';
export type RuntimeRequest = { id: number; kind: 'http' | 'login' | 'authority' | 'publicStats'; input: any };

// This source exists only in a generated, non-deployable temporary project.
// Install before ANY application require or cloud.init. It never keeps a native
// network/storage reference; the only communication is the explicit IDE queue.
function boundarySource(runId: string) {
  return `
const runId = ${JSON.stringify(runId)};
let sequence = 0, ready = [], pending = {}, storage = {}, blocked = [], completed = 0, cloudMethods = [];
const guards = [];
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
function bind(target, key, value, nativeProxyMethod) {
  target[key] = value;
  if (target[key] !== value) throw Error('ISOLATION_UNAVAILABLE:' + key);
  // Sealing the native cloud Proxy data property conflicts with its getter. No native
  // reference survives here; the captured stub still enforces the queue rules.
  if (nativeProxyMethod) return;
  Object.defineProperty(target, key, { value, writable: false, configurable: false });
  guards.push(() => target[key] === value);
}
function verify() { if (!guards.every(check => check())) throw Error('ISOLATION_CHANGED'); }
function deny(name) { return function() { blocked.push(name); throw Error('ISOLATED_API_REJECTED:' + name); }; }
function enqueue(kind, input, success, fail, complete) {
  verify();
  if (Object.keys(pending).length >= 64) throw Error('ISOLATED_QUEUE_LIMIT');
  const body = clone(input);
  if (JSON.stringify(body).length > 131072) throw Error('ISOLATED_BODY_LIMIT');
  const id = ++sequence;
  pending[id] = { success, fail, complete };
  ready.push({ id, kind, input: body });
  return { abort() { settle(id, false, { errMsg: 'request:fail abort' }); } };
}
function settle(id, ok, value) {
  const callbacks = pending[id];
  if (!callbacks) return false;
  delete pending[id]; completed++;
  const callback = ok ? callbacks.success : callbacks.fail;
  if (typeof callback === 'function') callback(clone(value));
  if (typeof callbacks.complete === 'function') callbacks.complete(clone(value));
  return true;
}
function install() {
  if (guards.length) throw Error('ISOLATION_ALREADY_INSTALLED');
  bind(wx, 'request', function(input) {
    if (!input || typeof input.url !== 'string' || !/^https:\\/\\/collect\\.linkx\\.ink\\/(api\\/v1\\/|v1\\/public-stats$)/.test(input.url)) {
      blocked.push('request');
      if (input && typeof input.fail === 'function') input.fail({ errMsg: 'request:fail isolated origin' });
      return { abort() {} };
    }
    return enqueue('http', { url: input.url, method: input.method || 'GET', data: input.data, header: input.header || {} },
      input.success, input.fail, input.complete);
  });
  ['uploadFile','downloadFile','connectSocket','login'].forEach(name => bind(wx, name, deny(name)));
  const replacement = {
    init() {},
    callFunction(input) {
      const valid = input && input.data && Object.keys(input.data).length === 1 &&
        (input.name === 'backend' && ['login','authority'].includes(input.data.action) ||
         input.name === 'statistics' && input.data.action === 'publicStats');
      if (!valid) {
        blocked.push('cloud.callFunction:' + String(input && input.name).slice(0,40) + ':' + String(input && input.data && input.data.action).slice(0,40));
        return Promise.reject(Error('ISOLATED_CLOUD_ACTION'));
      }
      return new Promise((resolve, reject) => enqueue(input.data.action, { name: input.name, data: input.data },
        value => { if (typeof input.success === 'function') input.success(value); resolve(value); },
        value => { if (typeof input.fail === 'function') input.fail(value); reject(value); }, input.complete));
    }
  };
  // DevTools exposes a non-replaceable cloud object. Its methods are verified
  // individually; callFunction keeps the native Proxy's property descriptor.
  const cloud = wx.cloud;
  if (!cloud) throw Error('ISOLATION_UNAVAILABLE:cloud');
  const required = ['init','callFunction','database','uploadFile','deleteFile','downloadFile','getTempFileURL','callContainer','Cloud'];
  cloudMethods = Array.from(new Set(required.concat(Object.getOwnPropertyNames(cloud)
    .filter(name => typeof Object.getOwnPropertyDescriptor(cloud, name).value === 'function'))));
  cloudMethods.forEach(name => bind(cloud, name, replacement[name] || deny('cloud.' + name), name === 'callFunction'));
  guards.push(() => wx.cloud === cloud);
  bind(wx, 'getStorageSync', key => clone(storage[key]));
  bind(wx, 'setStorageSync', (key, value) => { storage[key] = clone(value); });
  bind(wx, 'removeStorageSync', key => { delete storage[key]; });
  bind(wx, 'clearStorageSync', () => { storage = {}; });
  ['getStorage','setStorage','removeStorage','clearStorage','getStorageInfo','getStorageInfoSync'].forEach(name => bind(wx, name, deny(name)));
  verify();
}
const api = {
  runId, install,
  exchange(expected, replies) {
    if (expected !== runId) throw Error('WRONG_TEST_RUNTIME');
    verify();
    replies.forEach(reply => settle(reply.id, reply.ok, reply.value));
    const requests = ready.filter(item => pending[item.id]); ready = [];
    return { runId, requests, blocked: blocked.slice(), completed };
  },
  snapshot() { verify(); return { runId, cloudMethods, blocked: blocked.slice(), completed, pending: Object.keys(pending).length, probe: clone(api.probe) }; },
  beginProbe() {
    api.probe = { success: 0, failed: 0, aborted: 0, complete: 0, login: false, denied: 0 };
    wx.request({ url: '${origin}/api/v1/locations', success: value => { api.probe.success++; api.probe.ok = value.statusCode === 200 && !!value.data.data.fixedPlaces.length; }, fail: () => api.probe.failed++, complete: () => api.probe.complete++ });
    const aborted = wx.request({ url: '${origin}/api/v1/locations', success: () => api.probe.success++, fail: () => api.probe.aborted++, complete: () => api.probe.complete++ });
    aborted.abort(); aborted.abort();
    wx.request({ url: '${origin}/api/v1/locations', header: { 'x-linkx-probe-failure': '1' }, success: () => api.probe.success++, fail: () => api.probe.failed++, complete: () => api.probe.complete++ });
    cloudMethods.filter(name => !['init','callFunction'].includes(name)).forEach(name => { try { wx.cloud[name](); } catch (_) { api.probe.denied++; } });
    ['uploadFile','downloadFile','connectSocket','login'].forEach(name => { try { wx[name](); } catch (_) { api.probe.denied++; } });
    wx.cloud.callFunction({ name: 'backend', data: { action: 'login' } }).then(value => { api.probe.login = value.result.ok === true; });
  }
};
module.exports = api;
`;
}

export async function createDevtoolsHarness() {
  let project = await mkdtemp(join(tmpdir(), 'linkx-devtools-e2e-'));
  const projects = [project];
  // CLI argument files must be outside the watched mini-program tree: creating
  // one there can recompile/restart AppService between drain and acknowledgement.
  const argumentsDirectory = await mkdtemp(join(tmpdir(), 'linkx-devtools-driver-'));
  const runId = randomUUID();
  let opened = false, closed = false;
  async function cli(tool: string, args: string[] = []) {
    const result = await run('wechatide', ['-c', 'Codex', tool, '--project', project, ...args],
      { timeout: 45000, maxBuffer: 4 * 1024 * 1024 });
    const start = result.stdout.indexOf('{');
    assert.ok(start >= 0, `No tool JSON: ${tool}`);
    const value = JSON.parse(result.stdout.slice(start));
    assert.equal(value.ok, true, `${tool}: ${JSON.stringify(value)}`);
    if (value.result?.status === 'pending') throw Error(`IDE_CONFIRMATION_PENDING:${value.result.taskId}`);
    assert.notEqual(value.result?.success, false, `${tool}: ${JSON.stringify(value.result)}`);
    return value.result;
  }
  const config = JSON.parse(await readFile(join(root, 'project.config.json'), 'utf8'));
  delete config.cloudfunctionRoot; delete config.cloudfunctionTemplateRoot;
  config.projectname = `linkx-isolated-${runId.slice(0, 8)}`;
  config.setting.urlCheck = true;
  await writeFile(join(project, 'project.config.json'), JSON.stringify(config, null, 2), { mode: 0o600 });
  await writeFile(join(project, 'project.private.config.json'), JSON.stringify({ appid: config.appid,
    projectname: config.projectname, libVersion: config.libVersion, setting: { urlCheck: true, compileHotReLoad: false } }), { mode: 0o600 });
  await writeFile(join(project, '__test_boundary.js'), boundarySource(runId), { mode: 0o600 });
  await mkdir(join(project, 'probe'));
  await writeFile(join(project, 'app.js'), "require('./__test_boundary').install();\nApp({ __linkxHarness: require('./__test_boundary') });\n");
  await writeFile(join(project, 'app.json'), JSON.stringify({ pages: ['probe/index'], window: { navigationBarTitleText: 'Isolated boundary probe' } }));
  await writeFile(join(project, 'probe/index.js'), 'Page({data:{}});\n');
  await writeFile(join(project, 'probe/index.wxml'), '<view>Isolated transport probe</view>\n');
  await writeFile(join(project, 'probe/index.json'), '{}\n');
  async function evaluate(fnSource: string, args: any[] = []) {
    let value;
    if (!args.length) value = await cli('automation_evaluate', ['--fn-source', fnSource]);
    else {
      const file = join(argumentsDirectory, `${randomUUID()}.json`);
      await writeFile(file, JSON.stringify(args), { mode: 0o600 });
      try { value = await cli('automation_evaluate', ['--fn-source', fnSource, '--args-file', file]); }
      finally { await rm(file, { force: true }); }
    }
    assert.equal(value.success, true);
    // An expression returning undefined serializes as an empty result object.
    assert.ok(value.result && typeof value.result === 'object');
    return value.result.result;
  }
  return {
    get project() { return project; }, runId, cli, evaluate,
    async mockResult(method: string, result: object) {
      const file = join(argumentsDirectory, `${randomUUID()}.json`);
      await writeFile(file, JSON.stringify(result), { mode: 0o600 });
      try { return await cli('automation_wx_api', ['--action', 'mock', '--method', method, '--result-file', file]); }
      finally { await rm(file, { force: true }); }
    },
    async open() { opened = true; return cli('open_project_window', ['--window-mode', 'liteMode']); },
    async loadApplication() {
      // Change the manifest and page graph only while its isolated window is
      // closed; a watcher must never compile a partly copied application.
      await cli('close_project_window'); opened = false;
      // A distinct path also prevents DevTools from reusing the now-closed
      // probe's automator connection and compiled page graph.
      const probe = project;
      project = await mkdtemp(join(tmpdir(), 'linkx-devtools-e2e-'));
      projects.push(project);
      for (const name of ['project.config.json', 'project.private.config.json', '__test_boundary.js']) {
        await cp(join(probe, name), join(project, name));
      }
      for (const name of ['pages', 'components', 'custom-tab-bar', 'images', 'config', 'utils', 'templates', 'styles']) {
        await cp(join(root, name), join(project, name), { recursive: true, dereference: false });
      }
      for (const name of ['app.json', 'app.wxss', 'sitemap.json']) {
        try { await cp(join(root, name), join(project, name)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      const backend = await readFile(join(root, 'config/backend.js'), 'utf8');
      assert.ok(/mode: '(cloudbase|server)'/.test(backend));
      await writeFile(join(project, 'config/backend.js'), backend.replace(/mode: '(cloudbase|server)'/, "mode: 'server'"));
      const app = await readFile(join(root, 'app.js'), 'utf8');
      assert.equal(app.split('App({').length, 2);
      await writeFile(join(project, 'app.js'), "require('./__test_boundary').install();\n" +
        app.replace('App({', "App({\n  __linkxHarness: require('./__test_boundary'),"));
      opened = true;
      await cli('open_project_window', ['--window-mode', 'liteMode']);
    },
    async close() {
      if (closed) return;
      try {
        if (opened) { await cli('close_project_window'); opened = false; }
        closed = true;
      } finally {
        // A failed window close remains visible to the caller and retryable;
        // it must not skip reclamation of the exact temporary filesystem paths.
        for (const directory of projects) {
          assert.equal(resolve(directory).startsWith(resolve(tmpdir()) + '/linkx-devtools-e2e-'), true);
          await rm(directory, { recursive: true, force: true });
        }
        await rm(argumentsDirectory, { recursive: true, force: true });
      }
    },
  };
}
