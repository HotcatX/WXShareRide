'use strict'

const https = require('node:https')
const { TextDecoder } = require('node:util')

// Public configuration IDs from the verified handoff snapshot. They identify
// the four legacy lists, never a writable CloudBase resource in this relay.
const lists = {
  Departure: ['offer', 'fromPlaces', 'b4498fc86903a813018505643bc4ca31'],
  Arrival: ['offer', 'toPlaces', 'cd349d8f6903a85901817428411cfbff'],
  Departure_Request: ['request', 'fromPlaces', '4798591469645faa0bab74191c815837'],
  Arrival_Request: ['request', 'toPlaces', 'b4498fc869645e7c0bb50b4d0b12607e']
}
const URL = 'https://collect.linkx.ink/api/v1/locations'
const RESPONSE_LIMIT = 64 * 1024

function project(value, type) {
  const [kind, field, id] = lists[type]
  const values = value?.ok === true && value.data?.rideAddresses?.[kind]?.[field]
  if (!Array.isArray(values) || !values.length || values.length > 100 ||
    new Set(values).size !== values.length || values.some(value => typeof value !== 'string' ||
      !value.length || value.length > 200 || value.trim() !== value || /[\u0000-\u001f\u007f-\u009f]/u.test(value))) {
    throw Error('Invalid public address list')
  }
  return { success: true, id, addressList: values.slice() }
}

function createAddressListRelay({ request = https.request, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  return async event => {
    const type = event && typeof event === 'object' && !Array.isArray(event) ? event.type : undefined
    if (!type) return { success: false, message: '缺少参数 type' }
    if (typeof type !== 'string' || !Object.prototype.hasOwnProperty.call(lists, type)) {
      return { success: false, message: '不支持的地址类型' }
    }
    // Reserved platform metadata is neither identity evidence nor upstream
    // input. Match the other cloud bridges without reading or forwarding it.
    if (Object.keys(event).some(key => !['type', 'userInfo', 'tcbContext'].includes(key))) {
      return { success: false, message: '参数格式不正确' }
    }

    return new Promise(resolve => {
      let settled = false, req, res
      const finish = value => {
        if (settled) return
        settled = true
        clearTimer(deadline)
        resolve(value)
      }
      const fail = (error = 'ADDRESS_LIST_UNAVAILABLE') => {
        if (settled) return
        finish({ success: false, message: '加载失败', error })
        req?.destroy()
        res?.destroy()
      }
      // Wall-clock deadline includes DNS, TLS and a continuously streaming body.
      const deadline = setTimer(() => fail('ADDRESS_LIST_TIMEOUT'), 10000)
      try {
        req = request(URL, { method: 'GET', headers: { accept: 'application/json', 'accept-encoding': 'identity' } }, response => {
          res = response
          if (settled) { res.destroy(); return }
          const headers = res.headers
          const length = headers['content-length']
          if (res.statusCode !== 200 ||
            typeof headers['content-type'] !== 'string' || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(headers['content-type']) ||
            headers['content-encoding'] && headers['content-encoding'] !== 'identity' ||
            length !== undefined && (typeof length !== 'string' || !/^\d+$/.test(length) || Number(length) > RESPONSE_LIMIT)) {
            fail(); return
          }
          const expectedLength = length === undefined ? null : Number(length)
          const chunks = []
          let bytes = 0
          res.on('data', chunk => {
            if (settled) return
            bytes += chunk.length
            if (bytes > RESPONSE_LIMIT || expectedLength !== null && bytes > expectedLength) { fail(); return }
            chunks.push(Buffer.from(chunk))
          })
          res.on('aborted', () => fail())
          res.on('error', () => fail())
          res.on('close', () => { if (!settled) fail() })
          res.on('end', () => {
            if (settled) return
            if (res.complete === false || expectedLength !== null && bytes !== expectedLength) { fail(); return }
            try {
              const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
              finish(project(JSON.parse(text), type))
            } catch { fail() }
          })
        })
        req.on('error', () => fail())
        req.end()
      } catch { fail() }
    })
  }
}

exports.createAddressListRelay = createAddressListRelay
exports.main = createAddressListRelay()
