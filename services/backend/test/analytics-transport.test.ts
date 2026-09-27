import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { createCollectorTransport } from '../src/analytics/delivery.ts';
import { AppError } from '../src/errors.ts';

const origin = 'https://synthetic-collector.example';
const key = Buffer.alloc(32, 17);
const body = JSON.stringify({ schemaVersion: 1, events: [{ eventId: 'synthetic-event', label: '哥大 → Fort Lee' }] });
const ack = { ok: true, acceptedEventIds: ['synthetic-event'], duplicateEventIds: [] };
const unavailable = (error: unknown) => {
  assert.ok(error instanceof AppError); assert.equal(error.status, 503); assert.equal(error.code, 'COLLECTOR_DELIVERY_UNAVAILABLE');
  assert.doesNotMatch(error.message, /synthetic|secret|openid|signature|哥大/); return true;
};
type Request = { url: string; init: RequestInit; headers: Headers };
function transport(handler: (request: Request) => Response | Promise<Response>): typeof fetch {
  return async (input, init) => { assert.ok(init); return handler({ url: String(input), init, headers: new Headers(init.headers) }); };
}

test('collector signs the exact UTF-8 batch and fresh transport nonces for each attempt', async () => {
  const nonces = new Set<string>(); const configKey = Buffer.from(key);
  const send = createCollectorTransport({ origin, key: configKey }, transport(({ url, init, headers }) => {
    assert.equal(url, `${origin}/internal/v1/places/business-events`);
    assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error'); assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.body, body); assert.equal(headers.get('content-length'), String(Buffer.byteLength(body)));
    assert.equal(headers.get('content-type'), 'application/json'); assert.equal(headers.get('accept-encoding'), 'identity');
    const timestamp = headers.get('x-linkx-timestamp')!, nonce = headers.get('x-linkx-nonce')!;
    assert.match(timestamp, /^\d+$/); assert.ok(Math.abs(Number(timestamp) - Date.now()) < 5000); assert.match(nonce, /^[a-f0-9]{32}$/);
    assert.equal(nonces.has(nonce), false); nonces.add(nonce);
    assert.equal(headers.get('x-linkx-signature'), createHmac('sha256', key).update(timestamp).update('\n').update(nonce).update('\n').update(Buffer.from(body)).digest('hex'));
    return Response.json(ack);
  }));
  configKey.fill(0);
  assert.deepEqual(await send(body), ack); assert.deepEqual(await send(body), ack); assert.equal(nonces.size, 2);
});

test('collector accepts only a configured HTTPS origin and a bounded raw batch', async () => {
  for (const candidate of ['http://example.test', 'https://name:password@example.test', `${origin}/path`, `${origin}/`, `${origin}?secret=1`, `${origin}#fragment`, 'not-url']) {
    assert.throws(() => createCollectorTransport({ origin: candidate, key }), unavailable);
  }
  assert.throws(() => createCollectorTransport({ origin, key: Buffer.alloc(31) }), unavailable);
  let calls = 0;
  const send = createCollectorTransport({ origin, key }, transport(() => { calls++; return Response.json(ack); }));
  await assert.rejects(send(''), unavailable); await assert.rejects(send('x'.repeat(112 * 1024 + 1)), unavailable);
  assert.equal(calls, 0);
});

test('collector rejects redirects, failed statuses, malformed JSON and private provider errors without retries', async () => {
  for (const response of [new Response('', { status: 302, headers: { location: 'https://attacker.example/secret' } }),
    new Response('', { status: 201 }), new Response('synthetic secret provider failure', { status: 503 }),
    new Response('not-json'), new Response(Buffer.from([0xff, 0xff])), new Response(null)]) {
    let calls = 0;
    const send = createCollectorTransport({ origin, key }, transport(() => { calls++; return response; }));
    await assert.rejects(send(body), unavailable); assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(createCollectorTransport({ origin, key }, transport(() => {
    calls++; throw new Error('synthetic secret provider failure');
  }))(body), unavailable); assert.equal(calls, 1);
});

test('collector bounds reply headers and streamed bytes, verifies length and rejects compressed replies', async () => {
  for (const headers of [{ 'content-length': '8193' }, { 'content-length': 'NaN' }, { 'content-length': '-1' },
    { 'content-length': '1.5' }, { 'content-encoding': 'gzip' }, { 'content-encoding': 'br' }] as Record<string, string>[]) {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    await assert.rejects(createCollectorTransport({ origin, key }, transport(() => new Response(stream, { headers })))(body), unavailable);
    assert.equal(cancelled, true);
  }
  let cancelled = false;
  const oversized = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(8193)); }, cancel() { cancelled = true; } });
  await assert.rejects(createCollectorTransport({ origin, key }, transport(() => new Response(oversized)))(body), unavailable);
  assert.equal(cancelled, true);
  for (const length of ['1', '100']) await assert.rejects(createCollectorTransport({ origin, key },
    transport(() => new Response('{}', { headers: { 'content-length': length } })))(body), unavailable);
  const broken = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error('synthetic stream secret')); } });
  await assert.rejects(createCollectorTransport({ origin, key }, transport(() => new Response(broken)))(body), unavailable);
  assert.deepEqual(await createCollectorTransport({ origin, key }, transport(() => new Response(JSON.stringify(ack), {
    headers: { 'content-length': String(Buffer.byteLength(JSON.stringify(ack))), 'content-encoding': 'identity' }
  })))(body), ack);
});

test('collector applies a 6.5-second deadline to both headers and body with no background retry', async t => {
  const controllers: AbortController[] = [];
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    assert.equal(milliseconds, 6500); const controller = new AbortController(); controllers.push(controller); return controller.signal;
  });
  let calls = 0;
  const waitingHeaders = createCollectorTransport({ origin, key }, transport(({ init }) => {
    calls++; return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true }));
  }));
  const first = waitingHeaders(body); assert.equal(controllers.length, 1);
  controllers[0]!.abort(new Error('synthetic header timeout'));
  await assert.rejects(first, unavailable); assert.equal(calls, 1);
  let ready!: () => void;
  const listening = new Promise<void>(resolve => { ready = resolve; });
  const waitingStream = createCollectorTransport({ origin, key }, transport(({ init }) => {
    calls++; return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      init.signal!.addEventListener('abort', () => controller.error(init.signal!.reason), { once: true }); ready();
    } }));
  }));
  const second = waitingStream(body); await listening; assert.equal(controllers.length, 2);
  controllers[1]!.abort(new Error('synthetic body timeout'));
  await assert.rejects(second, unavailable); assert.equal(calls, 2);
});
