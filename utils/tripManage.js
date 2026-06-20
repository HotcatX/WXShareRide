function cleanText(value) {
  return String(value || "").trim()
}

function getResult(res) {
  return (res && res.result) || {}
}

const RIDE_LIST_CACHE_KEY = "carpoolListDataV1"
const RIDE_LIST_REFRESH_KEY = "rideListShouldRefreshAt"

async function callTripManage(data = {}) {
  const res = await wx.cloud.callFunction({
    name: "tripManage",
    data
  })
  return getResult(res)
}

function markRideListStale() {
  try {
    wx.removeStorageSync(RIDE_LIST_CACHE_KEY)
    wx.setStorageSync(RIDE_LIST_REFRESH_KEY, Date.now())
  } catch (e) {
  }
}

function askReason(options = {}) {
  return new Promise(resolve => {
    wx.showModal({
      title: options.title || "填写理由",
      content: options.content || "该理由会通过消息发送给相关成员。",
      editable: true,
      placeholderText: options.placeholder || "请填写原因",
      confirmText: options.confirmText || "确认",
      cancelText: "取消",
      success(res) {
        if (!res.confirm) {
          resolve("")
          return
        }
        const reason = cleanText(res.content)
        if (!reason) {
          wx.showToast({ title: "请填写理由", icon: "none" })
          resolve(null)
          return
        }
        resolve(reason)
      },
      fail() {
        resolve("")
      }
    })
  })
}

function askRating() {
  return new Promise(resolve => {
    wx.showActionSheet({
      itemList: ["5分", "4分", "3分", "2分", "1分"],
      success(scoreRes) {
        const score = 5 - Number(scoreRes.tapIndex || 0)
        resolve({ score })
      },
      fail() {
        resolve(null)
      }
    })
  })
}

async function rateTripUser(options = {}) {
  const targetOpenid = cleanText(options.targetOpenid)
  const tripId = cleanText(options.tripId || options.requestId || options.id)
  const type = cleanText(options.type || options.sourceType || "carpool") || "carpool"
  const targetRole = cleanText(options.targetRole)

  if (!targetOpenid) {
    wx.showToast({ title: "缺少评价对象", icon: "none" })
    return false
  }
  if (!tripId) {
    wx.showToast({ title: "缺少路线ID", icon: "none" })
    return false
  }

  const rating = await askRating()
  if (!rating) return false

  try {
    wx.showLoading({ title: "正在提交...", mask: true })
    const result = await callTripManage({
      action: "rateUser",
      type,
      tripId,
      requestId: tripId,
      targetOpenid,
      targetRole,
      score: rating.score
    })
    wx.hideLoading()

    if (result && (result.ok || result.success)) {
      wx.showToast({ title: "已提交评价", icon: "success" })
      return true
    }

    wx.showToast({ title: (result && result.errorMsg) || "评价失败", icon: "none" })
    return false
  } catch (err) {
    wx.hideLoading()
    console.error("rateTripUser failed:", err)
    wx.showToast({ title: "评价失败", icon: "none" })
    return false
  }
}

async function blockRideUser(options = {}) {
  const targetOpenid = cleanText(options.targetOpenid)
  const targetName = cleanText(options.targetName || options.name) || "该用户"
  const type = cleanText(options.type || options.sourceType || "carpool") || "carpool"
  const tripId = cleanText(options.tripId || options.id)
  const requestId = cleanText(options.requestId || options.tripId || options.id)

  if (!targetOpenid) {
    wx.showToast({ title: "缺少拉黑对象", icon: "none" })
    return false
  }

  return new Promise(resolve => {
    wx.showModal({
      title: "拉黑用户",
      content: `拉黑后，你们将无法加入彼此的拼车路线。确认拉黑${targetName}？`,
      confirmText: "拉黑",
      cancelText: "取消",
      success: async (res) => {
        if (!res.confirm) {
          resolve(false)
          return
        }
        try {
          wx.showLoading({ title: "正在处理...", mask: true })
          const result = await callTripManage({
            action: "blockUser",
            type,
            tripId,
            requestId,
            targetOpenid
          })
          wx.hideLoading()

          if (result && (result.ok || result.success)) {
            markRideListStale()
            wx.showToast({ title: "已拉黑", icon: "success" })
            resolve(true)
            return
          }

          wx.showToast({ title: (result && result.errorMsg) || "操作失败", icon: "none" })
          resolve(false)
        } catch (err) {
          wx.hideLoading()
          console.error("blockRideUser failed:", err)
          wx.showToast({ title: "操作失败", icon: "none" })
          resolve(false)
        }
      },
      fail() {
        resolve(false)
      }
    })
  })
}

function formatScore(value, count) {
  const n = Number(value || 0)
  return count > 0 && Number.isFinite(n) ? n.toFixed(1) : ""
}

function formatRideStats(rideStats = {}, role = "all") {
  const driverCompleted = Number(rideStats.completedDriverTrips || 0)
  const passengerCompleted = Number(rideStats.completedPassengerTrips || 0)
  const completed = role === "driver"
    ? driverCompleted
    : role === "passenger"
      ? passengerCompleted
      : Number(rideStats.completedTrips || (driverCompleted + passengerCompleted) || 0)

  const ratingCount = role === "driver"
    ? Number(rideStats.driverRatingCount || 0)
    : role === "passenger"
      ? Number(rideStats.passengerRatingCount || 0)
      : Number(rideStats.ratingCount || 0)

  const ratingAvgRaw = role === "driver"
    ? Number(rideStats.driverRatingWeightedAvg || rideStats.driverRatingAvg || 0)
    : role === "passenger"
      ? Number(rideStats.passengerRatingWeightedAvg || rideStats.passengerRatingAvg || 0)
      : Number(rideStats.ratingWeightedAvg || rideStats.ratingAvg || 0)

  const ratingAvg = ratingCount > 0 && Number.isFinite(ratingAvgRaw)
    ? ratingAvgRaw.toFixed(1)
    : ""

  const completeText = role === "driver"
    ? `司机完成 ${completed} 次`
    : role === "passenger"
      ? `已作为乘客 ${completed} 次`
      : `完成 ${completed} 次`

  return {
    completedTrips: completed,
    completedDriverTrips: driverCompleted,
    completedPassengerTrips: passengerCompleted,
    ratingCount,
    ratingAvg,
    completeText,
    summary: ratingCount > 0
      ? `${ratingAvg}分 · ${completeText}`
      : completeText
  }
}

function attachRideStats(user = {}, role = "all") {
  return {
    rideStats: user.rideStats || {},
    rideStatsText: formatRideStats(user.rideStats || {}, role).summary
  }
}

module.exports = {
  callTripManage,
  askReason,
  askRating,
  rateTripUser,
  blockRideUser,
  markRideListStale,
  formatScore,
  formatRideStats,
  attachRideStats
}
