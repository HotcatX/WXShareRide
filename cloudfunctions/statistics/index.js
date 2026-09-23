const cloud = require('wx-server-sdk')
const fs = require('fs')
const path = require('path')
const { createHandler } = require('./bridge')
const { createStatisticsHandler } = require('./handler')
const { createPlaceSynchronizer } = require('./placesSync')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
function getKeys() {
  // Private deployment files only. The identity key may also exist in a separate
  // root-only operations directory; it is never mounted into the collector.
  const secret = JSON.parse(fs.readFileSync(path.join(__dirname, 'participation.secret.json'), 'utf8'))
  if (!secret || !/^[a-f0-9]{64}$/.test(secret.bridge) || !/^[a-f0-9]{64}$/.test(secret.subject)) throw new Error('KEY_UNAVAILABLE')
  return { bridge: Buffer.from(secret.bridge, 'hex'), subject: Buffer.from(secret.subject, 'hex') }
}
const participation = createHandler({ getKeys })
exports.main = createStatisticsHandler({
  participation,
  synchronizePlaces: createPlaceSynchronizer({ db, getKey: () => getKeys().bridge,
    log: value => console.log(JSON.stringify(value)) }),
  getSyncKey() {
    const value = process.env.PUBLIC_STATS_SYNC_KEY || fs.readFileSync(path.join(__dirname, 'sync.secret'), 'utf8').trim()
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('KEY_UNAVAILABLE')
    return Buffer.from(value, 'hex')
  },
  readPublicStats: async () => {
    const result = await db.collection('PublicStats').doc('home').field({ servedTrips: true, coverageText: true }).get()
    return result.data
  },
  log: value => console.log(JSON.stringify(value))
})
