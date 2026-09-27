import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const origin = 'https://collect.linkx.ink';
const plain = (value: any) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

/** Actual CommonJS mini modules and Page controllers with native wx replaced
 * only at the test boundary. SDK origin validation is unchanged: this fixture
 * transports that exact origin to a loopback-only, real listening Fastify app.
 * No production CloudBase, external HTTP, UI renderer or device is involved. */
export function miniProgram(options: { url: string; appId: string; bridgeKey: Buffer; openid?: string }) {
  assert.equal(new URL(options.url).hostname, '127.0.0.1');
  const storage = new Map<string, any>([['openid', options.openid || ''], ['isGuest', !options.openid]]);
  const requests: Array<{ method: string; path: string; status?: number; body: any; key?: string }> = [];
  const toasts: any[] = [], modals: any[] = [], errors: any[] = [];
  const pages: any[] = [], timers = new Set<ReturnType<typeof setTimeout>>();
  const modules = new Map<string, any>(), failures = new Set<string>();
  let bridgeCalls = 0, definition: any;
  const wx: any = {
    getStorageSync: (key: string) => plain(storage.get(key)),
    setStorageSync: (key: string, value: any) => { storage.set(key, plain(value)); },
    removeStorageSync: (key: string) => { storage.delete(key); },
    getWindowInfo: () => ({ statusBarHeight: 44 }),
    getAccountInfoSync: () => ({ miniProgram: { appId: options.appId, envVersion: 'develop', version: '5.1.0-test' } }),
    showToast: (value: any) => { toasts.push(plain(value)); },
    showModal(value: any) {
      modals.push({ title: value.title, content: value.content });
      queueMicrotask(() => value.success?.({ confirm: true, cancel: false }));
    },
    navigateTo() {}, navigateBack() {}, reLaunch() {}, switchTab() {}, stopPullDownRefresh() {},
    cloud: {
      async callFunction(value: any) {
        assert.deepEqual(plain(value), { name: 'backend', data: { action: 'login' } }, 'no legacy business fallback');
        assert.ok(options.openid, 'guests never use a trusted login'); bridgeCalls++;
        // Synthetic identity belongs only to this trusted fixture. Exercise the
        // real HMAC/nonce/admission/session route instead of replacing auth.
        const body = JSON.stringify({ purpose: 'login', appId: options.appId, openid: options.openid, source: 'wx_client' });
        const at = String(Date.now()), nonce = randomBytes(16).toString('hex'), route = '/internal/v1/auth/cloudbase';
        const signature = createHmac('sha256', options.bridgeKey)
          .update(['linkx-auth-bridge-v1', 'POST', route, options.appId, at, nonce, ''].join('\n')).update(body).digest('hex');
        const response = await fetch(options.url + route, { method: 'POST', body, headers: {
          'content-type': 'application/json', 'x-linkx-auth-timestamp': at,
          'x-linkx-auth-nonce': nonce, 'x-linkx-auth-signature': signature,
        } });
        const data = await response.json(); assert.equal(response.status, 200, JSON.stringify(data));
        return { result: data };
      },
      database() { throw Error('Unexpected CloudBase database access'); },
      uploadFile() { throw Error('Unexpected CloudBase file upload'); },
      getTempFileURL() { throw Error('Unexpected CloudBase image read'); },
    },
    request(input: any) {
      const url = new URL(input.url);
      assert.equal(url.origin, origin, 'the production SDK keeps its fixed origin guard');
      const route = url.pathname + url.search;
      assert.ok(route.startsWith('/api/v1/'), 'this journey may only reach the isolated canonical API');
      const record = { method: input.method, path: url.pathname, body: plain(input.data), key: input.header?.['Idempotency-Key'], status: undefined as number | undefined };
      requests.push(record);
      const controller = new AbortController();
      void fetch(options.url + route, { method: input.method, headers: input.header, signal: controller.signal,
        ...(input.data === undefined ? {} : { body: JSON.stringify(input.data) }) }).then(async response => {
        record.status = response.status;
        const data = await response.json(), drop = `${input.method} ${url.pathname}`;
        if (response.ok && failures.delete(drop)) input.fail({ errMsg: 'synthetic lost ACK after real commit' });
        else input.success({ statusCode: response.status, data });
      }).catch(error => input.fail(error));
      return { abort: () => controller.abort() };
    },
  };
  const context = vm.createContext({ wx, console: { ...console, error: (...args: any[]) => errors.push(args) },
    Page: (value: any) => { definition = value; }, getCurrentPages: () => pages,
    setTimeout(callback: (...args: any[]) => void, milliseconds: number, ...args: any[]) {
      const timer = setTimeout(() => { timers.delete(timer); callback(...args); }, milliseconds); timer.unref(); timers.add(timer); return timer;
    },
    clearTimeout(timer: ReturnType<typeof setTimeout>) { timers.delete(timer); clearTimeout(timer); },
    Date, Intl, URL, URLSearchParams, Buffer, TextEncoder, TextDecoder, queueMicrotask,
  });
  function load(filename: string): any {
    const absolute = path.resolve(root, filename);
    assert.ok(absolute.startsWith(root), 'module stays within repository');
    const resolved = existsSync(absolute) ? absolute : absolute + '.js';
    if (modules.has(resolved)) return modules.get(resolved).exports;
    const module = { exports: {} as any }; modules.set(resolved, module);
    const localRequire = (specifier: string) => {
      assert.ok(specifier.startsWith('.'), `unexpected native dependency ${specifier}`);
      return load(path.relative(root, path.resolve(path.dirname(resolved), specifier)));
    };
    const execute = vm.runInContext(`(function(require,module,exports){\n${readFileSync(resolved, 'utf8')}\n})`, context, { filename: resolved });
    execute(localRequire, module, module.exports);
    // Only the bundled mode is test-selected. The real origin literal and SDK
    // restrictions, all compat modules, and application page code remain real.
    if (resolved === path.join(root, 'config/backend.js')) module.exports = { ...module.exports, mode: 'server' };
    return module.exports;
  }
  function page(filename: string) {
    definition = null; modules.delete(path.resolve(root, filename)); load(filename);
    assert.ok(definition, 'real source registered Page');
    const instance = { ...definition, data: plain(definition.data), setData(patch: Record<string, any>, done?: () => void) {
      for (const [key, value] of Object.entries(patch)) {
        const fields = key.replace(/\[(\d+)\]/g, '.$1').split('.');
        let target = this.data;
        for (const field of fields.slice(0, -1)) target = target[field] ??= {};
        target[fields.at(-1)!] = plain(value);
      }
      done?.call(this);
    } };
    pages.push(instance); return instance;
  }
  function unload() { pages.splice(0).forEach(page => page.onUnload?.()); timers.forEach(clearTimeout); timers.clear(); }
  return { wx, storage, requests, toasts, modals, errors, load, page, bridgeCalls: () => bridgeCalls,
    failAfterCommit(method: string, route: string) { failures.add(`${method} ${route}`); },
    restart() { unload(); modules.clear(); }, close: unload,
    async until(predicate: () => boolean, label: string) {
      const until = Date.now() + 8000;
      while (!predicate() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
      assert.ok(predicate(), `${label}; toasts=${JSON.stringify(toasts)}; requests=${JSON.stringify(requests.map(({ method,path,status }) => ({method,path,status})))}`);
    },
  };
}
