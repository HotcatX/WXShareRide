const fs = require('fs')
const path = require('path')
const { createBackendHandler } = require('./handler')

// Not deployed/enabled by committing this package. Use a new, purpose-specific
// key supplied privately at deployment; never reuse the collector bridge key.
function getKey() {
    const value = fs.readFileSync(path.join(__dirname, 'auth-bridge.secret'), 'utf8').trim()
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('LOGIN_UNAVAILABLE')
    return Buffer.from(value, 'hex')
}

exports.main = createBackendHandler({ authority: require('./authority'), getKey })
