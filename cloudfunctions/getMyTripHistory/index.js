// 云函数：getMyTripHistory（按 userInfo 三组历史ID回填 Carpool / CarpoolRequest）
//
// 规则：
// - tripDriverHistory       -> Carpool
// - tripDriverJoinHistory   -> CarpoolRequest
// - tripPassengerHistory    -> 可能是 Carpool 或 CarpoolRequest（两边都查，Carpool优先）
// - tripPassengerCreateHistory -> CarpoolRequest
//
// 返回：{ ok: true, data: [...] }
// 每条都会带：historyRole, historySource；缺失则 missing:true

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

function chunkArray(arr, size = 100) {
  const res = []
  for (let i = 0; i < arr.length; i += size) res.push(arr.slice(i, i + size))
  return res
}

function uniq(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)))
}

async function batchGetByIds(collectionName, ids) {
  const clean = uniq(ids)
  if (!clean.length) return []

  const chunks = chunkArray(clean, 100)
  let all = []
  for (const ck of chunks) {
    const r = await db.collection(collectionName).where({ _id: _.in(ck) }).get()
    all = all.concat(r.data || [])
  }
  return all
}

function buildMapById(docs) {
  const m = new Map()
  ;(docs || []).forEach(d => {
    if (d && d._id) m.set(d._id, d)
  })
  return m
}

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID

  if (!openid) return { ok: false, errorMsg: '未获取到 openid' }

  try {
    // 1) 读取 userInfo 三组历史ID
    const resUser = await db.collection('userInfo').where({ _openid: openid }).limit(1).get()
    if (!resUser.data || !resUser.data.length) {
      return { ok: true, data: [] }
    }

    const u = resUser.data[0]
    const tripDriverHistory = Array.isArray(u.tripDriverHistory) ? u.tripDriverHistory : []
    const tripDriverJoinHistory = Array.isArray(u.tripDriverJoinHistory) ? u.tripDriverJoinHistory : []
    const tripPassengerHistory = Array.isArray(u.tripPassengerHistory) ? u.tripPassengerHistory : []
    const tripPassengerCreateHistory = Array.isArray(u.tripPassengerCreateHistory) ? u.tripPassengerCreateHistory : []

    // 去重（各自集合内部即可；合并时再去一次）
    const driverCreateIds = uniq(tripDriverHistory)
    const driverJoinIds = uniq(tripDriverJoinHistory)
    const passengerIds = uniq(tripPassengerHistory)
    const passengerCreateIds = uniq(tripPassengerCreateHistory)

    // 2) 分别回填详情
    // 2.1 司机创建：只查 Carpool
    const carpoolDriverCreateDocs = await batchGetByIds('Carpool', driverCreateIds)
    const carpoolMap = buildMapById(carpoolDriverCreateDocs)

    // 2.2 司机加入：只查 CarpoolRequest
    const requestDriverJoinDocs = await batchGetByIds('CarpoolRequest', driverJoinIds)
    const requestMap = buildMapById(requestDriverJoinDocs)

    // 2.2.1 乘客发布求车历史：只查 CarpoolRequest
    const requestPassengerCreateDocs = await batchGetByIds('CarpoolRequest', passengerCreateIds)
    const requestPassengerCreateMap = buildMapById(requestPassengerCreateDocs)

    // 2.3 乘客历史：两边都查
    const passengerCarpoolDocs = await batchGetByIds('Carpool', passengerIds)
    const passengerRequestDocs = await batchGetByIds('CarpoolRequest', passengerIds)
    const passengerCarpoolMap = buildMapById(passengerCarpoolDocs)
    const passengerRequestMap = buildMapById(passengerRequestDocs)

    // 3) 组装输出（按三类来源分别生成，最后合并去重）
    const out = []

    // 工具：推入一条（如果找不到，推 missing 占位）
    const pushOne = (id, role, source, doc) => {
      if (doc) {
        out.push({
          ...doc,
          historyRole: role,
          historySource: source
        })
      } else {
        out.push({
          _id: id,
          historyRole: role,
          historySource: source,
          missing: true
        })
      }
    }

    // 3.1 driver_create
    for (const id of driverCreateIds) {
      pushOne(id, 'driver_create', 'Carpool', carpoolMap.get(id))
    }

    // 3.2 driver_join
    for (const id of driverJoinIds) {
      pushOne(id, 'driver_join', 'CarpoolRequest', requestMap.get(id))
    }

    // 3.2.1 passenger_create
    for (const id of passengerCreateIds) {
      pushOne(id, 'passenger_create', 'CarpoolRequest', requestPassengerCreateMap.get(id))
    }

    // 3.3 passenger（Carpool 优先；如需 CarpoolRequest 优先，把下面两行顺序对调即可）
    for (const id of passengerIds) {
      const docCarpool = passengerCarpoolMap.get(id)
      const docReq = passengerRequestMap.get(id)

      if (docCarpool) pushOne(id, 'passenger', 'Carpool', docCarpool)
      else if (docReq) pushOne(id, 'passenger', 'CarpoolRequest', docReq)
      else pushOne(id, 'passenger', 'Unknown', null)
    }

    // 4) 合并去重（同一个 _id 可能在不同列表重复出现：例如你既是司机创建又在 passengerHistory 里）
    // 这里策略：按 out 当前顺序“先到先得”，后来的同 id 丢弃。
    const seen = new Set()
    const merged = []
    for (const item of out) {
      const id = item && item._id
      if (!id) continue
      if (seen.has(id)) continue
      seen.add(id)
      merged.push(item)
    }

    // 5) 排序：尽量按你实际的时间字段倒序
    // 你可以把这里的字段名换成你两张表真实一致的字段
    merged.sort((a, b) => {
      const ta = new Date(a.departureTime || a.dateTime || a.updateTime || a.updatedAt || a.createdAt || 0).getTime()
      const tb = new Date(b.departureTime || b.dateTime || b.updateTime || b.updatedAt || b.createdAt || 0).getTime()
      return tb - ta
    })

    return { ok: true, data: merged }
  } catch (e) {
    console.error('【getMyTripHistory】异常：', e)
    return { ok: false, errorMsg: e.message || '获取历史行程失败' }
  }
}
