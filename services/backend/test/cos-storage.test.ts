import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import test from 'node:test';
import type { CosConfig } from '../src/config.ts';
import { AppError } from '../src/errors.ts';
import { createCosStorage } from '../src/files/cos.ts';

const config: CosConfig = { bucket: 'synthetic-images-1234567890', region: 'ap-shanghai',
  secretId: 'SyntheticAccessId000000', secretKey: 'SyntheticSecretKey000000', legacyEnvironment: 'cloud-fixture' };
const host = `${config.bucket}.cos.${config.region}.myqcloud.com`;
const key = 'linkx/images/0123456789abcdef/12345678-1234-1234-1234-123456789abc.png';
const locator = `cos://${config.bucket}/${key}`;
const bytes = Buffer.from([137, 80, 78, 71]);
const noVersioning = '<VersioningConfiguration/>';
const xmlError = (code: string) => `<Error><Code>${code}</Code><Message>synthetic-private-provider-detail</Message></Error>`;
type Request = { url: URL; init: RequestInit; headers: Headers };
function transport(handler: (request: Request) => Response | Promise<Response>): typeof fetch {
  return async (input, init) => {
    assert.equal(typeof input, 'string'); assert.ok(init);
    return handler({ url: new URL(String(input)), init, headers: new Headers(init.headers) });
  };
}
const rejected = (error: unknown) => {
  assert.ok(error instanceof AppError); assert.equal(error.status, 503); assert.equal(error.code, 'FILE_STORAGE_UNAVAILABLE');
  assert.ok(['图片服务暂不可用，请稍后重试', '图片尚未完成存储配置'].includes(error.message));
  assert.doesNotMatch(error.message, /synthetic|cloud:\/\/|cos:\/\/|q-sign|Secret|Access|NoSuch/);
  return true;
};
const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
function canonical(values: Record<string, string>) {
  return Object.keys(values).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map(name => `${encode(name).toLowerCase()}=${encode(values[name]!)}`).join('&');
}
/** Independent HMAC reconstruction checks host, path, headers and query, not
 * just whether the SDK returned a nonempty authorization string. */
function verifySignature(method: string, url: URL, auth: string, actualHeaders: Headers, expires: number) {
  const signature = new URLSearchParams(auth);
  assert.equal(signature.get('q-sign-algorithm'), 'sha1'); assert.equal(signature.get('q-ak'), config.secretId);
  const keyTime = signature.get('q-key-time')!;
  assert.equal(signature.get('q-sign-time'), keyTime);
  const [from, to] = keyTime.split(';').map(Number);
  assert.equal(to! - from!, expires);
  const headers: Record<string, string> = {};
  for (const name of signature.get('q-header-list')!.split(';').filter(Boolean)) {
    const value = name === 'host' ? url.host : actualHeaders.get(name);
    assert.notEqual(value, null); headers[name] = value!;
  }
  assert.equal(headers.host, host);
  const query: Record<string, string> = {};
  for (const name of signature.get('q-url-param-list')!.split(';').filter(Boolean)) {
    const value = url.searchParams.get(name); assert.notEqual(value, null); query[name] = value!;
  }
  const request = [method.toLowerCase(), decodeURIComponent(url.pathname), canonical(query), canonical(headers), ''].join('\n');
  const requestHash = createHash('sha1').update(request).digest('hex');
  const signKey = createHmac('sha1', config.secretKey).update(keyTime).digest('hex');
  const expected = createHmac('sha1', signKey).update(['sha1', keyTime, requestHash, ''].join('\n')).digest('hex');
  assert.equal(signature.get('q-signature'), expected);
  return signature;
}

test('COS signs versioning query, fixed host, body integrity and overwrite prohibition before every PUT', async () => {
  const requests: Request[] = [];
  const storage = createCosStorage(config, transport(request => {
    requests.push(request);
    assert.equal(request.url.protocol, 'https:'); assert.equal(request.url.host, host);
    assert.equal(request.init.redirect, 'error'); assert.ok(request.init.signal instanceof AbortSignal);
    const auth = verifySignature(request.init.method!, request.url, request.headers.get('authorization')!, request.headers, 60);
    if (request.init.method === 'GET') {
      assert.equal(request.url.pathname, '/'); assert.equal(request.url.searchParams.get('versioning'), '');
      assert.equal(auth.get('q-url-param-list'), 'versioning'); assert.equal(auth.get('q-header-list'), 'host');
      return new Response(noVersioning);
    }
    assert.equal(request.init.method, 'PUT'); assert.equal(request.url.pathname, `/${key}`);
    assert.deepEqual(Buffer.from(request.init.body as Uint8Array), bytes);
    assert.equal(request.headers.get('content-type'), 'image/png'); assert.equal(request.headers.get('content-length'), String(bytes.length));
    assert.equal(request.headers.get('content-md5'), createHash('md5').update(bytes).digest('base64'));
    assert.equal(request.headers.get('x-cos-forbid-overwrite'), 'true');
    for (const name of ['host', 'content-type', 'content-length', 'content-md5', 'cache-control', 'x-cos-forbid-overwrite']) {
      assert.ok(auth.get('q-header-list')!.split(';').includes(name));
    }
    return new Response('');
  }));
  await storage.objects.put(locator, bytes, 'image/png');
  await storage.objects.put(locator, bytes, 'image/png');
  assert.deepEqual(requests.map(request => request.init.method), ['GET', 'PUT', 'GET', 'PUT']);
});

test('COS rejects enabled, suspended, malformed or failed versioning checks without sending PUT', async () => {
  for (const [status, xml] of [[200, '<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>'],
    [200, '<VersioningConfiguration><Status>Suspended</Status></VersioningConfiguration>'],
    [200, '<Error/>'], [200, '<VersioningConfiguration/><Extra/>'], [200, '<!DOCTYPE dangerous><VersioningConfiguration/>'],
    [403, noVersioning]] as const) {
    let calls = 0;
    const storage = createCosStorage(config, transport(request => {
      calls++; assert.equal(request.init.method, 'GET'); return new Response(xml, { status });
    }));
    await assert.rejects(storage.objects.put(locator, bytes, 'image/png'), rejected); assert.equal(calls, 1);
  }
  for (const xml of [noVersioning, '<?xml version="1.0" encoding="UTF-8"?>\n<VersioningConfiguration></VersioningConfiguration>',
    '<VersioningConfiguration xmlns="http://cos.example.test/doc/2006-03-01/">\n</VersioningConfiguration>']) {
    await createCosStorage(config, transport(() => new Response(xml))).check();
  }
});

test('COS PUT only tolerates the documented FileAlreadyExists conflict and never retries transport errors', async () => {
  for (const [status, code, accepted] of [[409, 'FileAlreadyExists', true], [409, 'BucketAlreadyExists', false],
    [409, 'OperationAborted', false], [403, 'FileAlreadyExists', false], [201, '', false], [500, 'InternalError', false]] as const) {
    let calls = 0;
    const storage = createCosStorage(config, transport(request => {
      calls++; return request.init.method === 'GET' ? new Response(noVersioning) : new Response(xmlError(code), { status });
    }));
    const pending = storage.objects.put(locator, bytes, 'image/png');
    if (accepted) await pending; else await assert.rejects(pending, rejected);
    assert.equal(calls, 2);
  }
  let calls = 0;
  const storage = createCosStorage(config, transport(() => { calls++; throw new Error(`synthetic-private-provider-detail ${config.secretKey}`); }));
  await assert.rejects(storage.objects.put(locator, bytes, 'image/png'), rejected); assert.equal(calls, 1);
});

test('COS reads sign bounded range and distinguish missing object from missing bucket or denied reads', async () => {
  const storage = createCosStorage(config, transport(request => {
    assert.equal(request.init.method, 'GET'); assert.equal(request.headers.get('range'), 'bytes=0-4');
    const auth = verifySignature('GET', request.url, request.headers.get('authorization')!, request.headers, 60);
    assert.equal(auth.get('q-header-list'), 'host;range'); assert.equal(request.init.redirect, 'error');
    return new Response(bytes, { status: 206, headers: { 'content-range': 'bytes 0-3/4', 'content-type': 'Image/PNG; charset=binary' } });
  }));
  assert.deepEqual(await storage.objects.read(locator, 4), { body: bytes, mediaType: 'image/png' });
  for (const [status, code, missing] of [[404, 'NoSuchKey', true], [404, 'NoSuchBucket', false], [403, 'AccessDenied', false],
    [404, 'AccessDenied', false], [500, 'NoSuchKey', false], [416, 'InvalidRange', false]] as const) {
    const candidate = createCosStorage(config, transport(() => new Response(xmlError(code), { status })));
    if (missing) assert.equal(await candidate.objects.read(locator, 10), null);
    else await assert.rejects(candidate.objects.read(locator, 10), rejected);
  }
});

test('COS consumes bounded streams and rejects oversized headers/chunks, truncation and partial ranges', async () => {
  for (const length of ['5', 'NaN', '-1', '1.5', '9007199254740993']) {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const storage = createCosStorage(config, transport(() => new Response(body, { headers: { 'content-length': length } })));
    await assert.rejects(storage.objects.read(locator, 4), rejected); assert.equal(cancelled, true);
  }
  let cancelled = false, index = 0;
  const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(++index === 1 ? 3 : 2)); },
    cancel() { cancelled = true; } });
  await assert.rejects(createCosStorage(config, transport(() => new Response(body))).objects.read(locator, 4), rejected);
  assert.equal(cancelled, true);
  for (const [status, headers, data] of [
    [200, { 'content-length': '4' }, null],
    [200, { 'content-length': '4' }, bytes.subarray(0, 2)],
    [200, { 'content-length': '2' }, bytes],
    [206, { 'content-range': 'bytes 0-3/10' }, bytes],
    [206, { 'content-range': 'bytes 1-4/5' }, bytes],
    [206, { 'content-range': 'bytes 0-2/3' }, bytes],
    [206, { 'content-range': 'bytes 0-3/*' }, bytes],
    [206, {}, bytes],
  ] as const) {
    const storage = createCosStorage(config, transport(() => new Response(data, { status, headers })));
    await assert.rejects(storage.objects.read(locator, 4), rejected);
  }
  const broken = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error('synthetic stream secret')); } });
  await assert.rejects(createCosStorage(config, transport(() => new Response(broken))).objects.read(locator, 4), rejected);
  await assert.rejects(createCosStorage(config, transport(() => new Response('x'.repeat(16_385), { status: 404 }))).objects.read(locator, 4), rejected);
  for (const encoding of ['gzip', 'br', 'deflate']) {
    let cancelled = false;
    const compressed = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    await assert.rejects(createCosStorage(config, transport(() => new Response(compressed, {
      headers: { 'content-encoding': encoding }
    }))).objects.read(locator, 4), rejected);
    assert.equal(cancelled, true);
  }
  assert.deepEqual(await createCosStorage(config, transport(() => new Response(bytes, {
    headers: { 'content-encoding': 'identity', 'content-length': '4' }
  }))).objects.read(locator, 4), { body: bytes, mediaType: '' });
  let redirected = 0;
  await assert.rejects(createCosStorage(config, transport(request => {
    redirected++; assert.equal(request.init.redirect, 'error');
    return new Response('', { status: 302, headers: { location: 'https://attacker.example/leak' } });
  })).objects.read(locator, 4), rejected);
  assert.equal(redirected, 1);
});

test('COS passes a fresh hard deadline to fetch and the response stream, with no background retries', async t => {
  const controllers: AbortController[] = [];
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    assert.equal(milliseconds, 10_000); const controller = new AbortController(); controllers.push(controller); return controller.signal;
  });
  let calls = 0;
  const beforeHeaders = createCosStorage(config, transport(request => {
    calls++; return new Promise<Response>((_resolve, reject) => {
      request.init.signal!.addEventListener('abort', () => reject(request.init.signal!.reason), { once: true });
    });
  }));
  const pending = beforeHeaders.objects.read(locator, 4);
  assert.equal(controllers.length, 1); controllers[0]!.abort(new Error('synthetic-private-timeout'));
  await assert.rejects(pending, rejected); assert.equal(calls, 1);
  let listening!: () => void;
  const ready = new Promise<void>(resolve => { listening = resolve; });
  const stalledBody = createCosStorage(config, transport(request => {
    calls++; return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      request.init.signal!.addEventListener('abort', () => controller.error(request.init.signal!.reason), { once: true }); listening();
    } }));
  }));
  const reading = stalledBody.objects.read(locator, 4); await ready;
  assert.equal(controllers.length, 2); controllers[1]!.abort(new Error('synthetic-private-stream-timeout'));
  await assert.rejects(reading, rejected); assert.equal(calls, 2);
});

test('COS signed read URLs preserve exact legacy keys in one allowed bucket and enforce short TTL', async () => {
  let calls = 0;
  const storage = createCosStorage(config, transport(() => { calls++; throw new Error('No network should be used to sign'); }));
  for (const provider of ['cos', 'cloudbase'] as const) {
    const objectKey = "folder/中文 space+percent%2e/file(1)'!.png";
    const object = { id: 'synthetic-id', provider,
      locator: provider === 'cos' ? `cos://${config.bucket}/${objectKey}` : `cloud://${config.legacyEnvironment}.${config.bucket}/${objectKey}` };
    for (const ttl of [1, 300]) {
      const url = new URL(await storage.readUrl(object, ttl));
      assert.equal(url.origin, `https://${host}`); assert.equal(decodeURIComponent(url.pathname), `/${objectKey}`);
      assert.equal(url.searchParams.get('response-cache-control'), 'private, max-age=300');
      const signature = verifySignature('GET', url, url.searchParams.toString(), new Headers(), ttl);
      assert.equal(signature.get('q-header-list'), 'host'); assert.equal(signature.get('q-url-param-list'), 'response-cache-control');
      assert.equal(url.username, ''); assert.equal(url.password, ''); assert.equal(url.hash, '');
    }
  }
  for (const ttl of [0, -1, 301, 1.5, Number.NaN]) {
    await assert.rejects(storage.readUrl({ id: 'id', provider: 'cos', locator }, ttl), rejected);
  }
  assert.equal(calls, 0);
});

test('COS rejects cross-bucket locators, traversal and untrusted write paths before transport', async () => {
  let calls = 0;
  const storage = createCosStorage(config, transport(() => { calls++; return new Response(noVersioning); }));
  for (const path of ['', '/leading.png', './file.png', '../file.png', 'a/../file.png', 'a//file.png',
    'a\\file.png', 'a?download=1', 'a#fragment', 'a\u0000.png', 'x'.repeat(1025)]) {
    await assert.rejects(storage.readUrl({ id: 'id', provider: 'cos', locator: `cos://${config.bucket}/${path}` }, 300), rejected);
  }
  for (const [provider, object] of [['cos', 'https://attacker.example/image.png'], ['cos', 'cos://another-bucket-1234567/image.png'],
    ['cloudbase', `cloud://wrong-env.${config.bucket}/image.png`], ['cloudbase', `cloud://${config.legacyEnvironment}.another-bucket-1234567/image.png`],
    ['cos', `cloud://${config.legacyEnvironment}.${config.bucket}/image.png`]] as const) {
    await assert.rejects(storage.readUrl({ id: 'id', provider, locator: object }, 300), rejected);
  }
  const noLegacy = createCosStorage({ ...config, legacyEnvironment: undefined }, transport(() => { calls++; return new Response(''); }));
  await assert.rejects(noLegacy.readUrl({ id: 'id', provider: 'cloudbase', locator: `cloud://${config.legacyEnvironment}.${config.bucket}/image.png` }, 300), rejected);
  for (const [object, data, media] of [[`cos://${config.bucket}/arbitrary.png`, bytes, 'image/png'],
    [locator, bytes, 'image/svg+xml'], [locator, Buffer.alloc(0), 'image/png'], [locator, Buffer.alloc(2 * 1024 * 1024 + 1), 'image/png']] as const) {
    await assert.rejects(storage.objects.put(object, data, media), rejected);
  }
  for (const max of [0, -1, 2 * 1024 * 1024 + 1, 1.5, Number.NaN]) await assert.rejects(storage.objects.read(locator, max), rejected);
  assert.equal(calls, 0);
  assert.throws(() => createCosStorage({ ...config, bucket: `${config.bucket}.attacker.test` }), rejected);
  assert.throws(() => createCosStorage({ ...config, region: 'ap-shanghai.attacker.test' }), rejected);
});
