const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

function loadPage() {
  let page
  const filename = path.join(__dirname, '../pages/home/CarpoolTemplateList/CarpoolTemplateList.js')
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    Page: definition => { page = definition },
    require: () => ({ showDataError() {} }),
    console
  }, { filename })
  return page
}

const ids = rows => Array.from(rows, row => row._id)

test('weekly templates follow Monday to Sunday, then departure time, preserving equal-time order', () => {
  const page = loadPage()
  const templates = [
    { _id: 'sunday', weekdayIndex: 6, departureTime: '07:00', createdAt: 999 },
    { _id: 'tuesday-afternoon-first', weekdayIndex: 1, departureTime: '15:00', createdAt: 888 },
    { _id: 'monday-later', weekdayIndex: 0, departureTime: '18:30' },
    { _id: 'tuesday-morning', weekdayIndex: 1, departureTime: '9:00' },
    { _id: 'tuesday-afternoon-second', weekdayIndex: 1, departureTime: '15:00', createdAt: 999 },
    { _id: 'monday-first', weekdayIndex: 0, departureTime: '07:30' }
  ]
  assert.deepEqual(ids(page.decorateTemplateList(templates)), [
    'monday-first', 'monday-later', 'tuesday-morning', 'tuesday-afternoon-first', 'tuesday-afternoon-second', 'sunday'
  ])
})

test('valid numeric weekday takes priority and legacy weekday labels still display a weekly schedule', () => {
  const page = loadPage()
  const rows = page.decorateTemplateList([
    { _id: 'numeric', weekdayIndex: 1, weekdayText: '星期日', departureTime: '15:00:00' },
    { _id: 'legacy', weekdayText: '星期三', departureTime: '08:00' },
    { _id: 'zhou', weekdayText: '周一', departureTime: '09:00' },
    { _id: 'weekly', weekdayText: '每周五', departureTime: '10:00' },
    { _id: 'sunday', weekdayText: '星期天', departureTime: '11:00' }
  ])
  assert.deepEqual(ids(rows), ['zhou', 'numeric', 'legacy', 'weekly', 'sunday'])
  assert.equal(rows[1]._timeLabel, '每周二 15:00')
  assert.equal(rows[4]._timeLabel, '每周日 11:00')
})

test('unknown weekdays sort last without guessing from dates or invalid indexes', () => {
  const page = loadPage()
  const rows = page.decorateTemplateList([
    { _id: 'unknown-date', departureDate: '2026-09-22', departureTime: '06:00' },
    { _id: 'fraction', weekdayIndex: 1.2, departureTime: '08:00' },
    { _id: 'invalid-index', weekdayIndex: 7, weekdayText: '工作日', departureTime: '09:00' },
    { _id: 'sunday', weekdayIndex: 6, departureTime: '23:00' }
  ])
  assert.deepEqual(ids(rows), ['sunday', 'unknown-date', 'fraction', 'invalid-index'])
  for (const row of rows.slice(1)) assert.match(row._timeLabel, /^星期待设置 /)
})

test('unknown departure times stay after valid times on their weekday and are clearly marked', () => {
  const page = loadPage()
  const rows = page.decorateTemplateList([
    { _id: 'missing', weekdayIndex: 1 },
    { _id: 'invalid', weekdayIndex: 1, departureTime: '25:00' },
    { _id: 'valid', weekdayIndex: 1, departureTime: '15:00' },
    { _id: 'text', weekdayIndex: 1, departureTime: '下午三点' }
  ])
  assert.deepEqual(ids(rows), ['valid', 'missing', 'invalid', 'text'])
  assert.equal(rows[1]._timeLabel, '每周二 时间待设置')
})

test('decoration copies templates and preserves saved route, price, identity and input order', () => {
  const page = loadPage()
  const templates = [
    Object.freeze({ _id: 'tue', _openid: 'owner', weekdayIndex: 1, departureTime: '15:00', departureAddress: ' Fort Lee ', destinationAddress: ' 哥大 ', referencePrice: '8$/人', passengerCount: 3 }),
    Object.freeze({ _id: 'mon', weekdayIndex: 0, departureTime: '12:00' })
  ]
  const before = JSON.stringify(templates)
  Object.freeze(templates)
  const result = page.decorateTemplateList(templates)
  assert.equal(JSON.stringify(templates), before)
  assert.notEqual(result[1], templates[0])
  assert.equal(result[1]._fromAddress, 'Fort Lee')
  assert.equal(result[1]._toAddress, '哥大')
  assert.equal(result[1].departureAddress, ' Fort Lee ')
  assert.equal(result[1]._openid, 'owner')
  assert.equal(result[1].referencePrice, '8$/人')
  assert.equal(result[1].passengerCount, 3)
})
