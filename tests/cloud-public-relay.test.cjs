const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.resolve(__dirname, '..')

function entry(name) {
  const filename = path.join(root, 'cloudfunctions', name, 'index.js')
  const exports = {}
  const requested = []
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    exports,
    require(id) {
      requested.push(id)
      assert.equal(id, './publicRelay.js', 'live entry cannot load the archived writer or SDK')
      return require(path.join(path.dirname(filename), id))
    }
  }, { filename })
  assert.deepEqual(requested, ['./publicRelay.js'])
  return exports.main
}

for (const name of ['marketApi', 'webHouseShare']) {
  test(`${name} live package matches the canonical relay and has no CloudBase dependency`, () => {
    const dir = path.join(root, 'cloudfunctions', name)
    assert.deepEqual(fs.readFileSync(path.join(dir, 'publicRelay.js')),
      fs.readFileSync(path.join(root, 'services/backend/compat/legacy-public-relay.cjs')))
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'))).dependencies, {})
    assert.equal(typeof entry(name), 'function')
  })

  test(`${name} rejects legacy non-HTTP writes without any upstream request`, async () => {
    const main = entry(name)
    for (const action of ['create', 'update', 'remove', 'joinTrip', 'adminLogin']) {
      const result = await main({ action })
      assert.equal(result.code, 'MAINTENANCE')
      assert.equal(result.ok, false)
    }
  })
}

test('live HTTP entries reject old admin writes and non-read house methods locally', async () => {
  const market = await entry('marketApi')({ httpMethod: 'POST', path: '/admin-api', headers: {} })
  assert.equal(market.statusCode, 503)
  assert.equal(JSON.parse(market.body).code, 'MAINTENANCE')
  const house = await entry('webHouseShare')({ httpMethod: 'POST', headers: {} })
  assert.equal(house.statusCode, 405)
})
