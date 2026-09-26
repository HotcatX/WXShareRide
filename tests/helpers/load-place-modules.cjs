const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
module.exports = function loadPlaceModules(context, analytics = {}) {
  const modules = new Map()
  function load(name) {
    const key = path.basename(name)
    if (key === 'analyticsSession') return analytics
    if (key === 'cityTree') return require('../../utils/cityTree')
    if (modules.has(key)) return modules.get(key).exports
    const module = { exports: {} }; modules.set(key, module)
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../utils', key + '.js'), 'utf8'), { ...context, module, require: load })
    return module.exports
  }
  return load
}
