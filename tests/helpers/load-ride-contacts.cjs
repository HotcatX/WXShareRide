const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
// Exercise the actual authorized management view adapter with isolated server responses.
module.exports = function({ rides, profile, telemetry }) {
  const filename = path.join(__dirname, '../../utils/compat/rideContacts.js'), module = { exports: {} }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, setTimeout, clearTimeout,
    require(name) { return name === './rides' ? rides : name === './profile' ? profile : name === '../rideTelemetry' ? telemetry : require(path.resolve(path.dirname(filename), name)) } })
  return module.exports
}
