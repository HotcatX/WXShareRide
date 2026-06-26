function cleanText(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return ''
  return String(value).replace(/\s+/g, ' ').trim()
}

function isEmptyLocationText(value) {
  const text = cleanText(value)
  if (!text) return true
  return text === '无' || text === '—' || text === '-' || text === '未填写'
}

function isCountryOnly(value) {
  const text = cleanText(value).toUpperCase()
  return text === 'US' || text === 'CN' || text === 'USA' || text === 'CHINA' ||
    text === '美国' || text === '中国' || text === '中国大陆'
}

function getLocationObjectText(location = {}) {
  if (typeof location === 'string') return cleanText(location)
  if (!location || typeof location !== 'object') return ''
  return cleanText(
    location.displayName ||
    location.name ||
    location.address ||
    location.buildingName ||
    ''
  )
}

function firstDisplayText(values = []) {
  for (const value of values) {
    const text = cleanText(value)
    if (!text || isEmptyLocationText(text) || isCountryOnly(text)) continue
    return text
  }
  return ''
}

function buildProfileDisplayLocation(user = {}) {
  return firstDisplayText([
    user.bigregion,
    user.address,
    getLocationObjectText(user.location),
    user.apartment,
    user.dorm,
    user.addr,
    user.region
  ])
}

function buildProfileApartmentDisplay(user = {}) {
  const direct = firstDisplayText([user.apartment, user.dorm, user.addr])
  if (direct) return direct

  const region = firstDisplayText([user.bigregion])
  const address = firstDisplayText([user.address])
  if (region && address && region !== address) return address
  return ''
}

module.exports = {
  buildProfileDisplayLocation,
  buildProfileApartmentDisplay,
  getLocationObjectText
}
