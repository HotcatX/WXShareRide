const { callTripManage, markRideListStale } = require("../../../utils/tripManage")

function formatTime(value) {
  if (!value) return ""
  let date = null
  if (value instanceof Date) {
    date = value
  } else if (value && typeof value.toDate === "function") {
    date = value.toDate()
  } else if (value && value.$date) {
    date = new Date(value.$date)
  } else {
    date = new Date(value)
  }
  if (!date || Number.isNaN(date.getTime())) return ""

  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  const hh = String(date.getHours()).padStart(2, "0")
  const mm = String(date.getMinutes()).padStart(2, "0")
  return `${y}-${m}-${d} ${hh}:${mm}`
}

function normalizeItem(item = {}) {
  const openid = item.targetOpenid || item.openid || ""
  return {
    ...item,
    openid,
    targetOpenid: openid,
    name: item.name || "未设置昵称",
    avatarUrl: item.avatarUrl || "/images/profile.png",
    wechatID: item.wechatID || "",
    reason: item.reason || "",
    blockedAtText: formatTime(item.blockedAt || item.createdAt)
  }
}

Page({
  data: {
    statusBarHeight: 80,
    pageTitle: "黑名单",
    loading: true,
    list: []
  },

  onLoad() {
    const info = typeof wx.getWindowInfo === "function" ? wx.getWindowInfo() : wx.getSystemInfoSync()
    this.setData({ statusBarHeight: info.statusBarHeight || 0 })
  },

  onShow() {
    this.loadBlockList()
  },

  async onPullDownRefresh() {
    try {
      await this.loadBlockList()
    } finally {
      wx.stopPullDownRefresh()
    }
  },

  goBack() {
    const pages = getCurrentPages()
    if (pages.length > 1) wx.navigateBack()
    else wx.reLaunch({ url: "/pages/profile/profile" })
  },

  async loadBlockList() {
    this.setData({ loading: true })
    try {
      const result = await callTripManage({ action: "getBlockList" })
      if (result && (result.ok || result.success)) {
        const list = Array.isArray(result.list) ? result.list.map(normalizeItem) : []
        this.setData({ list, loading: false })
        return
      }
      wx.showToast({ title: (result && result.errorMsg) || "加载失败", icon: "none" })
    } catch (err) {
      console.error("loadBlockList failed:", err)
      wx.showToast({ title: "加载失败", icon: "none" })
    }
    this.setData({ list: [], loading: false })
  },

  onUnblockUser(e) {
    const dataset = (e && e.currentTarget && e.currentTarget.dataset) || {}
    const targetOpenid = dataset.openid || ""
    const targetName = dataset.name || "该用户"
    if (!targetOpenid) return

    wx.showModal({
      title: "解除拉黑",
      content: `解除后，你们可以再次加入彼此的路线。确认解除${targetName}？`,
      confirmText: "解除",
      cancelText: "取消",
      success: async (res) => {
        if (!res.confirm) return
        try {
          wx.showLoading({ title: "正在处理...", mask: true })
          const result = await callTripManage({ action: "unblockUser", targetOpenid })
          wx.hideLoading()

          if (result && (result.ok || result.success)) {
            markRideListStale()
            const list = this.data.list.filter(item => item.targetOpenid !== targetOpenid)
            this.setData({ list })
            wx.showToast({ title: "已解除", icon: "success" })
            return
          }

          wx.showToast({ title: (result && result.errorMsg) || "操作失败", icon: "none" })
        } catch (err) {
          wx.hideLoading()
          console.error("unblockUser failed:", err)
          wx.showToast({ title: "操作失败", icon: "none" })
        }
      }
    })
  }
})
