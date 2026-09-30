import { gzipSync, gunzipSync } from 'node:zlib';

export const MAX_PAYLOAD_BYTES = 65_536;

function invalid() { throw new Error('Invalid stored payload'); }

// The wire bytes, not a parsed/re-serialized JSON value, are the retry identity.
export function encodePayload(raw) {
  if (!Buffer.isBuffer(raw) || raw.length < 1 || raw.length > MAX_PAYLOAD_BYTES) invalid();
  const compressed = gzipSync(raw, { level: 6 });
  return compressed.length < raw.length
    ? { payload: compressed, codec: 'gzip', rawBytes: raw.length }
    : { payload: raw, codec: 'json', rawBytes: raw.length };
}

export function decodePayload(payload, codec = 'json', rawBytes = null) {
  if (!Buffer.isBuffer(payload) || payload.length < 1 || payload.length > MAX_PAYLOAD_BYTES
    || !['json', 'gzip'].includes(codec)
    || (rawBytes === null ? codec !== 'json' : !Number.isSafeInteger(rawBytes) || rawBytes < 1 || rawBytes > MAX_PAYLOAD_BYTES)) invalid();
  let raw;
  try {
    // Bound allocation while inflating, before checking the declared size.
    raw = codec === 'gzip' ? gunzipSync(payload, { maxOutputLength: MAX_PAYLOAD_BYTES }) : payload;
  } catch { invalid(); }
  if (raw.length < 1 || raw.length > MAX_PAYLOAD_BYTES || (rawBytes !== null && raw.length !== rawBytes)) invalid();
  return raw;
}
