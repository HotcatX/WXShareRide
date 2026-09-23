const { extractRidePriceNumber } = require("./tripManage")

function normalizePlace(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, "")
}

function getDriverRoutePriceKey(departure, destination) {
  const from = normalizePlace(departure)
  const to = normalizePlace(destination)
  const fortLee = from === "哥大" ? to : to === "哥大" ? from : ""

  if (fortLee === "fortlee" || fortLee === "fortlee核心区") return "fortLeeCore"
  if (fortLee === "fortlee全区域") return "fortLeeNonCore"
  return ""
}

function getDriverRouteDefaultPrice(departure, destination, customPrice = {}) {
  const key = getDriverRoutePriceKey(departure, destination)
  if (!key) return ""
  if (key === "fortLeeCore") return "8"
  const savedValue = customPrice && customPrice[key]
  const savedPrice = extractRidePriceNumber(savedValue == null ? "" : String(savedValue))
  return savedPrice || "13"
}

module.exports = { getDriverRouteDefaultPrice, getDriverRoutePriceKey }
