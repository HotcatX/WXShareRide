// 云函数：editMyRequestDetailCreate（无 await 版本，避免 SyntaxError）
// 乘客（创建者）管理 CarpoolRequest：剔除司机 / 剔除乘客 / 创建者删除路线并彻底清理
// ✅ 加入 Notifications 通知：
// - kickDriver / kickPassenger：只通知被剔除成员
// - creatorQuitAndDelete：删除成功后通知所有司机和乘客（默认不通知创建者本人）

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

function uniq(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)))
}

/**
 * 写入 Notifications（失败不阻断主流程）
 */
function sendNotification(toOpenid, type, title, content, carpoolId, extra) {
  if (!toOpenid) return Promise.resolve(false)
  return db.collection('Notifications').add({
    data: {
      _openid: toOpenid,
      type,
      title,
      content,
      carpoolId: carpoolId || '',
      extra: extra || {},
      read: false,
      createdAt: db.serverDate()
    }
  }).then(() => true).catch((e) => {
    console.error('[sendNotification] 写入通知失败：', e)
    return false
  })
}

function buildRouteText(req) {
  const dep = (req && req.departures && req.departures[0]) ? req.departures[0] : {}
  const des = (req && req.destinations && req.destinations[0]) ? req.destinations[0] : {}
  const dateStr = dep.date || ''
  const timeStr = dep.time || ''
  const routeStr = (dep.address && des.address) ? (dep.address + ' -> ' + des.address) : '该求车路线'
  return { dateStr, timeStr, routeStr }
}

function buildClearDriverFields(req) {
  const next = {}
  if (Object.prototype.hasOwnProperty.call(req, 'driverOpenid')) next.driverOpenid = ''
  if (Object.prototype.hasOwnProperty.call(req, 'driverID')) next.driverID = ''
  if (Object.prototype.hasOwnProperty.call(req, 'driverId')) next.driverId = ''
  return next
}

function getUserInfoByOpenid(openid) {
  if (!openid) return Promise.resolve(null)
  return db.collection('userInfo').where({ _openid: openid }).limit(1).get().then((r) => {
    return (r && r.data && r.data[0]) ? r.data[0] : null
  })
}

function getUserInfoDocIdByOpenid(openid) {
  return getUserInfoByOpenid(openid).then((doc) => (doc && doc._id) ? doc._id : '')
}

// 强制移除：把字段当数组处理并 set 回去
function forceRemoveIdFromArrayField(openid, fieldName, idToRemove) {
  return getUserInfoByOpenid(openid).then((doc) => {
    if (!doc || !doc._id) return { ok: false, reason: 'no_userInfo_doc' }

    const oldVal = doc[fieldName]
    const arr = Array.isArray(oldVal) ? oldVal : []
    const nextArr = arr.filter((x) => x !== idToRemove)

    const shouldWrite = (!Array.isArray(oldVal)) || (arr.length !== nextArr.length)
    if (!shouldWrite) return { ok: true, changed: false }

    return db.collection('userInfo').doc(doc._id).update({
      data: { [fieldName]: nextArr }
    }).then(() => ({ ok: true, changed: true }))
  })
}

function stillHas(openid, fieldName, id) {
  return getUserInfoByOpenid(openid).then((doc) => {
    if (!doc) return false
    const v = doc[fieldName]
    return Array.isArray(v) && v.includes(id)
  })
}

exports.main = (event, context) => {
  const wxContext = cloud.getWXContext()
  const myOpenid = wxContext.OPENID

  const requestId = event.requestId || event.id || ''
  const action = event.action || ''
  const targetOpenid = event.targetOpenid || ''

  if (!myOpenid) return Promise.resolve({ ok: false, errorMsg: '未获取到 openid' })
  if (!requestId) return Promise.resolve({ ok: false, errorMsg: '缺少 requestId' })
  if (!action) return Promise.resolve({ ok: false, errorMsg: '缺少 action' })

  const reqRef = db.collection('CarpoolRequest').doc(requestId)

  // 先读路线并校验创建者身份
  return reqRef.get().then((preSnap) => {
    const preReq = preSnap && preSnap.data ? preSnap.data : null
    if (!preReq) return { ok: false, errorMsg: '未找到该路线' }

    const creatorOpenid = preReq._openid || preReq.creatorOpenid || preReq.passengerOpenid || ''
    if (!creatorOpenid || creatorOpenid !== myOpenid) {
      return { ok: false, errorMsg: '仅创建者可执行该操作' }
    }

    // ====== kickDriver ======
    if (action === 'kickDriver') {
      const driver = preReq.driverOpenid || preReq.driverID || preReq.driverId || ''
      if (!driver) return { ok: false, errorMsg: '当前无司机' }

      const next = buildClearDriverFields(preReq)
      const reqStatus = preReq.status || ''
      if (reqStatus && reqStatus !== 'past' && reqStatus !== 'close') next.status = 'open'
      if (Object.keys(next).length === 0) {
        return { ok: false, errorMsg: '该路线不包含 driver 字段，无法清除' }
      }

      return reqRef.update({ data: next }).then(() => {
        return getUserInfoDocIdByOpenid(driver).then((driverDocId) => {
          if (!driverDocId) return { ok: true, warnings: [{ step: 'cleanDriverUserInfo', reason: 'no_userInfo_doc' }] }
          return db.collection('userInfo').doc(driverDocId).update({
            data: {
              tripDriverJoin: _.pull(requestId),
              tripDriver: _.pull(requestId)
            }
          }).then(() => ({ ok: true, warnings: [] }))
        })
      }).then((ret) => {
        // ✅ 只通知被剔除的司机
        const t = buildRouteText(preReq)
        const title = '你已被移出该求车路线'
        const content = '你已被创建者移出：' + t.dateStr + ' ' + t.timeStr + ' ' + t.routeStr
        return sendNotification(driver, 'KICKED_FROM_REQUEST', title, content, requestId, {
          action: 'kickDriver',
          requestId,
          by: myOpenid
        }).then(() => ret)
      }).catch((e) => ({
        ok: false,
        errorMsg: '操作失败（kickDriver）',
        debug: { errMsg: e && e.errMsg, message: e && e.message }
      }))
    }

    // ====== kickPassenger ======
    if (action === 'kickPassenger') {
      const passengerOpenids = Array.isArray(preReq.passengerID) ? preReq.passengerID.filter(Boolean) : []
      if (!targetOpenid) return { ok: false, errorMsg: '缺少 targetOpenid' }
      if (targetOpenid === creatorOpenid) return { ok: false, errorMsg: '不能剔除创建者' }
      if (!passengerOpenids.includes(targetOpenid)) return { ok: false, errorMsg: '该乘客不在队列中' }

      const updateData = {}
      if (Array.isArray(preReq.passengerID)) updateData.passengerID = _.pull(targetOpenid)
      if (typeof preReq.passengerCount === 'number') {
        updateData.passengerCount = Math.max(0, preReq.passengerCount - 1)
      }

      return reqRef.update({ data: updateData }).then(() => {
        return getUserInfoDocIdByOpenid(targetOpenid).then((pDocId) => {
          if (!pDocId) return { ok: true, warnings: [{ step: 'cleanPassengerUserInfo', reason: 'no_userInfo_doc' }] }
          return db.collection('userInfo').doc(pDocId).update({
            data: { tripPassenger: _.pull(requestId) }
          }).then(() => ({ ok: true, warnings: [] }))
        })
      }).then((ret) => {
        // ✅ 只通知被剔除的乘客
        const t = buildRouteText(preReq)
        const title = '你已被移出该求车路线'
        const content = '你已被创建者移出：' + t.dateStr + ' ' + t.timeStr + ' ' + t.routeStr
        return sendNotification(targetOpenid, 'KICKED_FROM_REQUEST', title, content, requestId, {
          action: 'kickPassenger',
          requestId,
          by: myOpenid
        }).then(() => ret)
      }).catch((e) => ({
        ok: false,
        errorMsg: '操作失败（kickPassenger）',
        debug: { errMsg: e && e.errMsg, message: e && e.message }
      }))
    }

    // ====== creatorQuitAndDelete ======
    if (action === 'creatorQuitAndDelete') {
      const warnings = []

      console.log('[creatorQuitAndDelete] requestId=', requestId, ' myOpenid=', myOpenid)

      // 再读一次最新路线
      return reqRef.get().then((latestSnap) => {
        const latestReq = latestSnap && latestSnap.data ? latestSnap.data : null
        if (!latestReq) return { ok: false, errorMsg: '未找到该路线（删除前读取失败）' }

        const creator = latestReq._openid || latestReq.creatorOpenid || latestReq.passengerOpenid || ''
        if (!creator || creator !== myOpenid) {
          return { ok: false, errorMsg: '仅创建者可执行该操作' }
        }

        const driver = latestReq.driverOpenid || latestReq.driverID || latestReq.driverId || ''
        const passengers = Array.isArray(latestReq.passengerID) ? latestReq.passengerID : []
        const uniqPassengers = uniq(passengers)

        // 1) 清创建者 tripPassengerCreate
        return forceRemoveIdFromArrayField(creator, 'tripPassengerCreate', requestId)
          .then((r1) => { if (!r1.ok) warnings.push({ step: 'creator_tripPassengerCreate', openid: creator, reason: r1.reason }) })
          // 2) 清所有乘客 tripPassenger
          .then(() => {
            return Promise.all(uniqPassengers.map((op) => {
              return forceRemoveIdFromArrayField(op, 'tripPassenger', requestId).then((r2) => {
                if (!r2.ok) warnings.push({ step: 'passenger_tripPassenger', openid: op, reason: r2.reason })
              })
            }))
          })
          // 3) 清司机 tripDriverJoin
          .then(() => {
            if (!driver) return null
            return forceRemoveIdFromArrayField(driver, 'tripDriverJoin', requestId).then((r3) => {
              if (!r3.ok) warnings.push({ step: 'driver_tripDriverJoin', openid: driver, reason: r3.reason })
            })
          })
          // 4) 复核：只要还有残留就不删
          .then(() => {
            const remain = []
            return stillHas(creator, 'tripPassengerCreate', requestId).then((hasC) => {
              if (hasC) remain.push({ openid: creator, field: 'tripPassengerCreate' })

              return Promise.all(uniqPassengers.map((op) => {
                return stillHas(op, 'tripPassenger', requestId).then((hasP) => {
                  if (hasP) remain.push({ openid: op, field: 'tripPassenger' })
                })
              })).then(() => {
                if (!driver) return Promise.resolve(remain)

                return stillHas(driver, 'tripDriverJoin', requestId).then((hasD) => {
                  if (hasD) remain.push({ openid: driver, field: 'tripDriverJoin' })
                  return remain
                })
              })
            }).then((remain) => {
              if (remain.length > 0) {
                return {
                  ok: false,
                  errorMsg: 'userInfo 清理未完成，已阻止删除 CarpoolRequest（请重试或后台补偿）',
                  remain,
                  warnings
                }
              }

              // 5) 删除 CarpoolRequest（硬诊断：删前存在性、删后存在性都回传前端）
              return reqRef.get().then((beforeSnap) => {
                const existsBefore = !!(beforeSnap && beforeSnap.data)

                // 把关键诊断信息回传
                const diag = {
                  env: cloud.DYNAMIC_CURRENT_ENV || 'N/A',
                  requestId,
                  existsBefore
                }

                if (!existsBefore) {
                  return {
                    ok: false,
                    errorMsg: '删除前校验失败：CarpoolRequest 文档不存在（requestId不对或环境不一致）',
                    warnings,
                    debug: diag
                  }
                }

                return reqRef.remove().then((delRes) => {
                  const removed = delRes && delRes.stats ? delRes.stats.removed : 0
                  diag.removed = removed

                  if (removed !== 1) {
                    return {
                      ok: false,
                      errorMsg: 'remove 已执行但 removed != 1（极可能 requestId 不对 / 文档并非该环境）',
                      warnings,
                      debug: { ...diag, delRes }
                    }
                  }

                  // 删除后再 get 一次确认
                  return reqRef.get().then((afterSnap) => {
                    const existsAfter = !!(afterSnap && afterSnap.data)
                    diag.existsAfter = existsAfter

                    if (existsAfter) {
                      return {
                        ok: false,
                        errorMsg: 'remove 显示删除成功，但删除后仍可读取到文档：请检查是否看错环境/集合',
                        warnings,
                        debug: diag
                      }
                    }

                    // ✅ 删除成功：通知所有人（司机 + 全部乘客）
                    const driver2 = latestReq.driverOpenid || latestReq.driverID || latestReq.driverId || ''
                    const passengers2 = Array.isArray(latestReq.passengerID) ? latestReq.passengerID : []
                    const allTargets = uniq([driver2].concat(passengers2))

                    // 默认不通知创建者本人；如你要通知创建者，把下面过滤条件去掉即可
                    const targets = allTargets.filter((x) => x && x !== myOpenid)

                    const t2 = buildRouteText(latestReq)
                    const title2 = '求车路线已被删除'
                    const content2 = '该路线已被创建者删除：' + t2.dateStr + ' ' + t2.timeStr + ' ' + t2.routeStr

                    return Promise.all(
                      targets.map((to) => sendNotification(to, 'REQUEST_DELETED', title2, content2, requestId, {
                        action: 'creatorQuitAndDelete',
                        requestId,
                        by: myOpenid
                      }))
                    ).then(() => {
                      return { ok: true, warnings, debug: diag }
                    })
                  }).catch((eAfter) => {
                    // 有时 get 会直接报 not found，也视为删除成功
                    diag.existsAfter = false
                    diag.getAfterErr = eAfter && (eAfter.errMsg || eAfter.message)

                    // ✅ 删除成功：通知所有人（司机 + 全部乘客）
                    const driver2 = latestReq.driverOpenid || latestReq.driverID || latestReq.driverId || ''
                    const passengers2 = Array.isArray(latestReq.passengerID) ? latestReq.passengerID : []
                    const allTargets = uniq([driver2].concat(passengers2))
                    const targets = allTargets.filter((x) => x && x !== myOpenid)

                    const t2 = buildRouteText(latestReq)
                    const title2 = '求车路线已被删除'
                    const content2 = '该路线已被创建者删除：' + t2.dateStr + ' ' + t2.timeStr + ' ' + t2.routeStr

                    return Promise.all(
                      targets.map((to) => sendNotification(to, 'REQUEST_DELETED', title2, content2, requestId, {
                        action: 'creatorQuitAndDelete',
                        requestId,
                        by: myOpenid
                      }))
                    ).then(() => {
                      return { ok: true, warnings, debug: diag }
                    })
                  })
                }).catch((eRemove) => {
                  return {
                    ok: false,
                    errorMsg: 'remove 调用失败（可能权限/环境/集合问题）',
                    warnings,
                    debug: {
                      ...diag,
                      errMsg: eRemove && eRemove.errMsg,
                      message: eRemove && eRemove.message
                    }
                  }
                })
              })
            })
          })
      }).catch((e) => {
        console.error('[creatorQuitAndDelete] error=', e)
        return { ok: false, errorMsg: '操作失败（creatorQuitAndDelete）', debug: { errMsg: e && e.errMsg, message: e && e.message } }
      })
    }

    // ====== creatorQuitAndClose（保留：close但不删）=====
    if (action === 'creatorQuitAndClose') {
      const next = { status: 'close', ...buildClearDriverFields(preReq) }
      return reqRef.update({ data: next }).then(() => ({ ok: true }))
        .catch((e) => ({ ok: false, errorMsg: '操作失败（creatorQuitAndClose）', debug: { errMsg: e && e.errMsg, message: e && e.message } }))
    }

    return { ok: false, errorMsg: '不支持的 action' }
  }).catch((e) => {
    console.error('【editMyRequestDetailCreate】error:', e)
    return {
      ok: false,
      errorMsg: '操作失败（云函数异常）',
      debug: { errMsg: e && e.errMsg, message: e && e.message, stack: e && e.stack }
    }
  })
}
