const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(path.join(__dirname, '../components/ride-time-picker/index.js'), 'utf8')
const plain = value => JSON.parse(JSON.stringify(value))

function harness(value = '') {
  let definition
  class Clock extends Date {
    constructor(...args) {
      super(...(args.length ? args : [Date.parse('2030-05-05T18:37:00Z')]))
    }
  }
  vm.runInNewContext(source, { Component: input => { definition = input }, Date: Clock, require: () => require('../utils/rideTime') })
  const events = []
  const component = {
    ...definition.methods,
    data: plain(definition.data),
    properties: { visible: false, value },
    setData(patch) { Object.assign(this.data, plain(patch)) },
    triggerEvent(name, detail) { events.push({ name, detail: detail == null ? null : plain(detail) }) }
  }
  function visible(next) {
    component.properties.visible = next
    definition.observers.visible.call(component, next)
  }
  return {
    component, events, visible,
    change(hour, minute) { component.onChange({ detail: { value: [hour, minute] } }) }
  }
}

test('time picker retains arbitrary minute precision and includes every hour and minute', () => {
  const { component, visible, events } = harness('09:07')
  visible(true)
  assert.equal(component.data.hours.length, 24)
  assert.deepEqual(component.data.hours.slice(-2), ['22', '23'])
  assert.equal(component.data.minutes.length, 60)
  assert.deepEqual(component.data.minutes.slice(5, 9), ['05', '06', '07', '08'])
  assert.deepEqual(component.data.pickerValue, [9, 7])
  assert.equal(component.data.selectedTime, '09:07')
  component.onConfirm()
  assert.deepEqual(events, [{ name: 'confirm', detail: { value: '09:07' } }])
})

test('midnight and the final minute are selectable and emit padded 24-hour values', () => {
  const { component, visible, change, events } = harness('23:59')
  visible(true)
  assert.deepEqual(component.data.pickerValue, [23, 59])
  component.onConfirm()
  visible(false)
  visible(true)
  change(0, 0)
  component.onConfirm()
  assert.deepEqual(events, [
    { name: 'confirm', detail: { value: '23:59' } },
    { name: 'confirm', detail: { value: '00:00' } }
  ])
})

test('cancel discards a changed draft and reopening restores the external time', () => {
  const { component, visible, change, events } = harness('08:12')
  visible(true)
  change(16, 43)
  assert.equal(component.data.selectedTime, '16:43')
  assert.equal(component.properties.value, '08:12')
  component.onCancel()
  assert.deepEqual(events, [{ name: 'cancel', detail: null }])
  visible(false)
  visible(true)
  assert.equal(component.data.selectedTime, '08:12')
  assert.deepEqual(component.data.pickerValue, [8, 12])
  component.properties.value = '19:28'
  visible(false)
  visible(true)
  assert.equal(component.data.selectedTime, '19:28')
})

test('scrolling disables confirm until the final changed value has settled', () => {
  const { component, visible, change, events } = harness('08:00')
  visible(true)
  component.onPickStart()
  assert.equal(component.data.isPicking, true)
  change(10, 59)
  component.onConfirm()
  assert.equal(events.length, 0)
  component.onPickEnd()
  assert.equal(component.data.isPicking, false)
  component.onConfirm()
  assert.deepEqual(events, [{ name: 'confirm', detail: { value: '10:59' } }])
})

test('cancelling while the wheel moves cannot confirm a stale draft and reopening resets scroll state', () => {
  const { component, visible, change, events } = harness('06:07')
  visible(true)
  component.onPickStart()
  component.onCancel()
  change(21, 30)
  component.onPickEnd()
  component.onConfirm()
  assert.deepEqual(events, [{ name: 'cancel', detail: null }])
  visible(false)
  visible(true)
  assert.equal(component.data.isPicking, false)
  component.onConfirm()
  assert.deepEqual(events.at(-1), { name: 'confirm', detail: { value: '06:07' } })
})

test('missing and invalid external times use the current New York hour and minute', () => {
  for (const value of ['', '24:00', '12:60', '7:09', '07:9', '09:07:00', ' 09:07 ', 'invalid', null]) {
    const { component, visible } = harness(value)
    visible(true)
    assert.equal(component.data.selectedTime, '14:37', String(value))
    assert.deepEqual(component.data.pickerValue, [14, 37])
  }
})

test('invalid wheel indices leave the last valid draft unchanged', () => {
  const { component, visible, change, events } = harness('07:07')
  visible(true)
  for (const [hour, minute] of [[-1, 0], [24, 0], [0, -1], [0, 60], [1.5, 0], [0, '5']]) {
    change(hour, minute)
    assert.equal(component.data.selectedTime, '07:07')
  }
  component.onChange({ detail: { value: [12] } })
  component.onChange({ detail: {} })
  component.onChange(null)
  component.onConfirm()
  assert.deepEqual(events, [{ name: 'confirm', detail: { value: '07:07' } }])
})

test('hidden actions and repeated confirmation cannot emit extra events', () => {
  const { component, visible, change, events } = harness('18:03')
  change(12, 0)
  component.onPickStart()
  component.onConfirm()
  component.onCancel()
  assert.equal(events.length, 0)
  visible(true)
  change(19, 4)
  visible(true)
  assert.equal(component.data.selectedTime, '19:04', 'an unchanged visible prop does not replace a draft')
  component.onConfirm()
  component.onConfirm()
  component.onCancel()
  assert.deepEqual(events, [{ name: 'confirm', detail: { value: '19:04' } }])
})
