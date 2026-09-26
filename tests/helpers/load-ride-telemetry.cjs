const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
module.exports = function loadRideTelemetry(analytics = {}, options = {}) {
  const module = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../utils/rideTelemetry.js'), 'utf8'), {
    module, require: name => name === './analyticsSession' ? analytics : require(path.join(__dirname, '../../utils', name)), setTimeout, clearTimeout, Date, ...options
  })
  return module.exports
}
