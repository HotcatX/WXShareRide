// Temporary migration boundary. Change only with the single-writer handoff;
// failures in server mode must never send a write back to CloudBase.
module.exports = Object.freeze({ mode: 'cloudbase', origin: 'https://collect.linkx.ink' })
