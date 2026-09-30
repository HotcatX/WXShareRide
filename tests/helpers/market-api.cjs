const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
module.exports = function loadMarket(wx, backend = {}, options = {}) {
  const module = { exports: {} }
  const client = backend
  if (!client.isBackendEnabled) client.isBackendEnabled = () => true
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../utils/compat/market.js'), 'utf8'), {
    module, wx, console, setTimeout, clearTimeout, ...options,
    require(name) {
      if (name === '../backendClient') return client
      if (name === './profile') return require('./profile-api.cjs')(wx, client)
      throw Error(`Unexpected market dependency ${name}`)
    }
  })
  return module.exports
}
