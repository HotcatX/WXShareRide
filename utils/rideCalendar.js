function parseMonth(month) {
  if (typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)) throw new Error('invalid calendar month')
  const [year, number] = month.split('-').map(Number)
  if (year < 1000 || year > 9999 || number < 1 || number > 12) throw new Error('invalid calendar month')
  return { year, number }
}

function shiftMonth(month, delta) {
  const { year, number } = parseMonth(month)
  const date = new Date(Date.UTC(year, number - 1 + delta, 1))
  const result = date.toISOString().slice(0, 7)
  parseMonth(result)
  return result
}

function formatMonthTitle(month) {
  const { year, number } = parseMonth(month)
  return `${year}年${number}月`
}

function buildCalendarDays({ month, today, selectedDate = '', counts = {}, countsReady = false }) {
  const { year, number } = parseMonth(month)
  const leading = (new Date(Date.UTC(year, number - 1, 1)).getUTCDay() + 6) % 7
  const daysInMonth = new Date(Date.UTC(year, number, 0)).getUTCDate()
  const cells = Math.ceil((leading + daysInMonth) / 7) * 7
  return Array.from({ length: cells }, (_, index) => {
    const day = index - leading + 1
    if (day < 1 || day > daysInMonth) return { key: `${month}-blank-${index}`, isPlaceholder: true }
    const date = `${month}-${String(day).padStart(2, '0')}`
    const value = counts[date] || {}
    const validCount = n => Number.isSafeInteger(n) && n >= 0 ? n : 0
    const carpoolCount = validCount(value.carpoolCount)
    const requestCount = validCount(value.requestCount)
    return {
      key: date, date, day, isPlaceholder: false,
      isPast: date < today, isToday: date === today, isSelected: date === selectedDate,
      carpoolCount, requestCount, countsReady,
      carpoolText: countsReady ? `${carpoolCount > 999 ? '999+' : carpoolCount}发` : '—发',
      requestText: countsReady ? `${requestCount > 999 ? '999+' : requestCount}求` : '—求'
    }
  })
}

module.exports = { buildCalendarDays, shiftMonth, formatMonthTitle }
