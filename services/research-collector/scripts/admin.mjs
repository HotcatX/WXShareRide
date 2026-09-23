import http from 'node:http';
import { readFileSync } from 'node:fs';

// Use stdin or a local JSON file, never put tokens or participant data in argv.
const commands = {
  status: ['GET', '/v1/status'], state: ['POST', '/v1/participants/state'],
  token: ['POST', '/v1/tokens'], 'recovery-complete': ['POST', '/v1/recovery/complete'],
  'places-status': ['GET', '/v1/places/status'], 'places-approve': ['POST', '/v1/places/catalog/approve'],
  'places-seed': ['POST', '/v1/places/catalog/seed'], 'places-pending': ['POST', '/v1/places/catalog/pending'],
};
const command = commands[process.argv[2]];
if (!command) throw new Error('Usage: admin.mjs status|state|token|recovery-complete [json-file; otherwise stdin]');
const [method, path] = command;
const body = method === 'POST' ? JSON.stringify(JSON.parse(readFileSync(process.argv[3] || 0, 'utf8'))) : '';
const req = http.request({ socketPath: process.env.ADMIN_SOCKET || './data/run/admin.sock', path, method,
  headers: { Authorization: `Bearer ${readFileSync(process.env.ADMIN_TOKEN_FILE || './secrets/admin.token', 'utf8').trim()}`,
    'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
  let output = ''; res.setEncoding('utf8'); res.on('data', data => { output += data; });
  res.on('end', () => { process.stdout.write(output + '\n'); if (res.statusCode !== 200) process.exitCode = 1; });
});
req.on('error', () => { process.stderr.write('Local admin connection failed\n'); process.exitCode = 1; });
req.end(body);
