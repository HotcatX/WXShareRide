const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
module.exports = function profileApi(wx, backend = { isBackendEnabled: () => false }) {
  const module = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../utils/compat/profile.js'), 'utf8'), {
    module, wx, require(name) { if (name === '../backendClient') return backend; throw new Error(name) }
  })
  return module.exports
}
