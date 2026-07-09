function getUpdateResult(res) {
  return (res && res.result) || {}
}

function isMissingUserCreateBranchError(result = {}) {
  const message = String(result.errorMsg || result.message || result.error || "")
  return /\b(?:region|address) is not defined\b/i.test(message)
}

async function callUpdateUser(data = {}) {
  const firstResponse = await wx.cloud.callFunction({
    name: "updateUser",
    data
  })
  const firstResult = getUpdateResult(firstResponse)

  if (firstResult.ok || !isMissingUserCreateBranchError(firstResult)) {
    return firstResponse
  }

  const loginResponse = await wx.cloud.callFunction({
    name: "login",
    data: {}
  })
  const loginResult = getUpdateResult(loginResponse)
  if (!loginResult.ok) return firstResponse

  if (loginResult.openid) {
    wx.setStorageSync("openid", loginResult.openid)
    wx.setStorageSync("isGuest", false)
  }

  return wx.cloud.callFunction({
    name: "updateUser",
    data
  })
}

module.exports = {
  callUpdateUser
}
