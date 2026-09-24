// Ride dates and clock times belong to the New York/New Jersey service area,
// regardless of the phone's time zone. UTC-only arithmetic also works in WeChat
// runtimes without Intl time-zone data. US DST rules below apply from 2007 on.
const RIDE_TIME_ZONE = 'America/New_York'
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const pad = value => String(value).padStart(2, '0')

function isValidRideDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  if (year < 1000 || year > 9999) return false
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function shiftRideDate(value, days) {
  if (!isValidRideDate(value) || !Number.isInteger(days)) return ''
  return new Date(Date.parse(`${value}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)
}

function getRideWeekday(value) {
  return isValidRideDate(value) ? new Date(`${value}T00:00:00Z`).getUTCDay() : NaN
}

function newYorkOffsetHours(timestamp) {
  const year = new Date(timestamp).getUTCFullYear()
  const firstSunday = month => 1 + (7 - new Date(Date.UTC(year, month - 1, 1)).getUTCDay()) % 7
  // 02:00 EST on the second Sunday in March -> 07:00 UTC.
  // 02:00 EDT on the first Sunday in November -> 06:00 UTC.
  const start = Date.UTC(year, 2, firstSunday(3) + 7, 7)
  const end = Date.UTC(year, 10, firstSunday(11), 6)
  return timestamp >= start && timestamp < end ? -4 : -5
}

function getRideDateTime(now = Date.now()) {
  const timestamp = typeof now === 'number' ? now : Number(now)
  if (!Number.isFinite(timestamp)) return null
  const date = new Date(timestamp + newYorkOffsetHours(timestamp) * HOUR_MS)
  const year = date.getUTCFullYear()
  const month = date.getUTCMonth() + 1
  const day = date.getUTCDate()
  const hour = date.getUTCHours()
  const minute = date.getUTCMinutes()
  const second = date.getUTCSeconds()
  return { year, month, day, hour, minute, second,
    date: `${year}-${pad(month)}-${pad(day)}`,
    time: `${pad(hour)}:${pad(minute)}` }
}

function getRideDateData(now = Date.now()) {
  const current = getRideDateTime(now)
  const todayDateStr = current ? current.date : ''
  return { todayDateStr, tomorrowDateStr: shiftRideDate(todayDateStr, 1) }
}

function parseRideDateTime(date, time) {
  if (!isValidRideDate(date) || typeof time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(time)) return NaN
  const [year, month, day] = date.split('-').map(Number)
  const [hour, minute, second = 0] = time.split(':').map(Number)
  const wallTime = Date.UTC(year, month - 1, day, hour, minute, second)
  // Validate both possible offsets by round-trip: skipped spring hours have no
  // match; repeated autumn hours select the earlier occurrence, like the server.
  for (const offset of [-4, -5]) {
    const timestamp = wallTime - offset * HOUR_MS
    const actual = getRideDateTime(timestamp)
    if (actual.date === date && actual.hour === hour && actual.minute === minute && actual.second === second) return timestamp
  }
  return NaN
}

// Weekly schedules keep their New York wall clock, including across DST. A
// history shortcut starts at least one calendar week after its source trip;
// a saved template (no afterDate) uses the next available weekly occurrence.
function getNextWeeklyRideDate(weekdayIndex, time, options = {}) {
  if (!Number.isInteger(weekdayIndex) || weekdayIndex < 0 || weekdayIndex > 6 ||
      typeof time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) return ''
  const now = options.now === undefined ? Date.now() : options.now
  if (!Number.isFinite(now)) return ''
  const today = getRideDateData(now).todayDateStr
  if (!isValidRideDate(today)) return ''
  const targetDay = (weekdayIndex + 1) % 7
  let candidate = shiftRideDate(today, (targetDay - getRideWeekday(today) + 7) % 7)
  if (options.afterDate !== undefined) {
    if (!isValidRideDate(options.afterDate)) return ''
    const earliest = shiftRideDate(options.afterDate, 7)
    if (!isValidRideDate(earliest)) return ''
    if (candidate < earliest) {
      const days = (Date.parse(`${earliest}T00:00:00Z`) - Date.parse(`${candidate}T00:00:00Z`)) / DAY_MS
      candidate = shiftRideDate(candidate, Math.ceil(days / 7) * 7)
    }
  }
  const lastDate = shiftRideDate(today, 30)
  while (isValidRideDate(candidate) && candidate <= lastDate) {
    const timestamp = parseRideDateTime(candidate, time)
    if (Number.isFinite(timestamp) && timestamp >= now + 15 * 60 * 1000 && timestamp <= now + 30 * DAY_MS) return candidate
    candidate = shiftRideDate(candidate, 7)
  }
  return ''
}

module.exports = { RIDE_TIME_ZONE, getRideDateTime, getRideDateData, parseRideDateTime, shiftRideDate, isValidRideDate, getRideWeekday, getNextWeeklyRideDate }
