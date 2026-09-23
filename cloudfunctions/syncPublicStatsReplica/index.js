const cloud = require('wx-server-sdk')
const fs = require('fs')
const path = require('path')
const { createLegacyTimer } = require('./relay')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// Keep the existing timer during migration. It verifies the original trigger,
// signs a narrowly scoped relay, and delegates all DB reading/publishing.
exports.main = createLegacyTimer({
  getKey() {
    const value = process.env.PUBLIC_STATS_SYNC_KEY || fs.readFileSync(path.join(__dirname, 'sync.secret'), 'utf8').trim()
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('KEY_UNAVAILABLE')
    return Buffer.from(value, 'hex')
  },
  invoke: args => cloud.callFunction(args),
  log: value => console.log(JSON.stringify(value))
})
