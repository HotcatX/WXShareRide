const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
// Exercise the real helper's legacy branch with an explicitly selected source.
// Production's singleton deliberately has no default before the App handshake.
module.exports = function() {
  const filename = path.join(__dirname, '../../utils/compat/rideContacts.js'), module = { exports: {} }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, setTimeout, clearTimeout,
    require(name) { return name === './rides' ? { isBackendEnabled: () => false } : require(path.resolve(path.dirname(filename), name)) } })
  return module.exports
}
