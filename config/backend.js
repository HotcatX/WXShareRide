// Deployment authority consumed by sync-cloud-authority.mjs (two values only).
// The released client selects its source with the trusted authority handshake;
// this bundled value is NOT a client fallback. Change only at writer handoff.
module.exports = Object.freeze({ mode: 'cloudbase', origin: 'https://collect.linkx.ink' })
