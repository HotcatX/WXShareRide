import http from 'node:http';
import { lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseInput, readPrivateFile, readStdin } from './stop-collection.mjs';
import { DIAGNOSTIC_ROUTE, MAX_DIAGNOSTIC_BYTES, validateDiagnosticRequest, projectDiagnosticResponse } from '../src/diagnostics.mjs';

export const SOCKET_PATH = '/run/linkx-collector/admin.sock';
const ADMIN_TOKEN_FILE = '/run/linkx-admin.token';
const SAFE_ERRORS = new Set(['ROOT_REQUIRED', 'INVALID_ARGUMENTS', 'INVALID_INPUT', 'PRIVATE_FILE_UNAVAILABLE',
  'KEY_UNAVAILABLE', 'ADMIN_UNAVAILABLE', 'ADMIN_UNAUTHORIZED', 'INVALID_DIAGNOSTIC_REQUEST',
  'INVALID_DIAGNOSTIC_RESPONSE', 'PARTICIPANT_KIND_IMMUTABLE', 'DIAGNOSTIC_SCHEMA_UNAVAILABLE',
  'STORAGE_UNAVAILABLE', 'SERVER_BUSY']);
class DiagnosticError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = code => { throw new DiagnosticError(code); };

export function parseOptions(argv, now = Date.now()) {
  const options = { mode: 'real', from: now - 86_400_000, to: now, limit: 50 };
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]; const value = argv[i + 1];
    if (!['--mode', '--from', '--to', '--limit', '--input-file'].includes(flag) || !value || seen.has(flag)) fail('INVALID_ARGUMENTS');
    seen.add(flag);
    if (flag === '--mode') { if (!['real', 'test'].includes(value)) fail('INVALID_ARGUMENTS'); options.mode = value; }
    else if (flag === '--input-file') options.inputFile = value;
    else { if (!/^(0|[1-9][0-9]{0,15})$/.test(value)) fail('INVALID_ARGUMENTS'); options[flag.slice(2)] = Number(value); }
  }
  try { validateDiagnosticRequest({ openid: 'validation_placeholder', synthetic: options.mode === 'test', from: options.from, to: options.to, limit: options.limit }, now); }
  catch { fail('INVALID_ARGUMENTS'); }
  return options;
}

export function sendAdmin(body, adminToken, { request = http.request, timeoutMs = 3000 } = {}) {
  if (typeof adminToken !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(adminToken) ||
    !Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 3000) fail('KEY_UNAVAILABLE');
  const raw = JSON.stringify(body);
  return new Promise((resolvePromise, reject) => {
    let settled = false; let req;
    const finish = (error, result) => {
      if (settled) return; settled = true; clearTimeout(deadline);
      if (error) reject(new DiagnosticError(error)); else resolvePromise(result);
    };
    const deadline = setTimeout(() => { finish('ADMIN_UNAVAILABLE'); req?.destroy(); }, timeoutMs);
    try {
      req = request({ socketPath: SOCKET_PATH, path: DIAGNOSTIC_ROUTE, method: 'POST', agent: false, maxHeaderSize: 4096,
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) } }, res => {
        const chunks = []; let size = 0;
        res.on('data', chunk => {
          size += chunk.length;
          if (size > MAX_DIAGNOSTIC_BYTES) { finish('ADMIN_UNAVAILABLE'); req.destroy(); return; }
          chunks.push(chunk);
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
            if (res.statusCode === 200) return finish(null, parsed);
            finish(parsed?.ok === false && SAFE_ERRORS.has(parsed.error) ? parsed.error : 'ADMIN_UNAVAILABLE');
          } catch { finish('ADMIN_UNAVAILABLE'); }
        });
        res.on('error', () => finish('ADMIN_UNAVAILABLE')); res.on('aborted', () => finish('ADMIN_UNAVAILABLE'));
      });
      req.on('error', () => finish('ADMIN_UNAVAILABLE')); req.end(raw);
    } catch { finish('ADMIN_UNAVAILABLE'); }
  });
}

export async function diagnoseAccount({ openid, adminToken, mode = 'real', from, to, limit = 50, transport = sendAdmin }) {
  try {
    if (!['real', 'test'].includes(mode)) fail('INVALID_ARGUMENTS');
    const body = validateDiagnosticRequest({ openid, synthetic: mode === 'test', from, to, limit });
    const response = projectDiagnosticResponse(await transport(body, adminToken), body.synthetic);
    if (response.coverage.from !== from || response.coverage.to !== to || response.coverage.limit !== limit) fail('INVALID_DIAGNOSTIC_RESPONSE');
    if (response.account && response.account.openid !== openid) fail('INVALID_DIAGNOSTIC_RESPONSE');
    return response;
  } catch (error) { return { ok: false, error: SAFE_ERRORS.has(error?.code) ? error.code : 'OPERATION_FAILED' }; }
}

export async function main(argv = process.argv.slice(2)) {
  let raw; let tokenRaw;
  try {
    if (typeof process.getuid !== 'function' || process.getuid() !== 0) fail('ROOT_REQUIRED');
    const options = parseOptions(argv);
    raw = options.inputFile ? readPrivateFile(options.inputFile, 4096) : await readStdin(process.stdin);
    const openid = parseInput(raw);
    // Keep existing collector UID-1000 ownership/mode; only the root operations
    // process has DAC_OVERRIDE, limited to these explicitly mounted files/socket.
    tokenRaw = readPrivateFile(ADMIN_TOKEN_FILE, 512, 1000);
    const adminToken = new TextDecoder('utf-8', { fatal: true }).decode(tokenRaw).trim();
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(adminToken)) fail('KEY_UNAVAILABLE');
    const socket = lstatSync(SOCKET_PATH);
    if (!socket.isSocket() || socket.uid !== 1000 || (socket.mode & 0o777) !== 0o600) fail('ADMIN_UNAVAILABLE');
    return await diagnoseAccount({ openid, adminToken, ...options });
  } catch (error) { return { ok: false, error: SAFE_ERRORS.has(error?.code) ? error.code : 'OPERATION_FAILED' }; }
  finally { raw?.fill(0); tokenRaw?.fill(0); }
}

// Importing the module never reads production files, stdin, or a live database.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await main(); process.stdout.write(JSON.stringify(result) + '\n'); process.exitCode = result.ok ? 0 : 1;
}
