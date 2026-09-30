const profile = require("../../../utils/compat/profile")
const contacts = require("../../../utils/compat/rideContacts")
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
  return {
    ...item,
    name: item.name || "未设置昵称",
    avatarUrl: item.avatarUrl || "/images/profile.png",
    wechatID: item.wechatId || "",
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
    this._hidden = false
    if (this._listIdentity !== profile.identity()) this.setData({ list: [] })
    this.loadBlockList()
  },

  onHide() { this._hidden = true; this.clearRefreshTimer() },

  clearRefreshTimer() { if (this._refreshTimer) clearTimeout(this._refreshTimer); this._refreshTimer = null },

  onUnload() { this.clearRefreshTimer(); this._disposed = true; this._listRevision = (this._listRevision || 0) + 1 },

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
    if (this._disposed) return
    this.clearRefreshTimer()
    const identity = profile.identity(), revision = this._listRevision = (this._listRevision || 0) + 1
    this._listIdentity = identity
    const current = () => !this._disposed && this._listRevision === revision && profile.identity() === identity
    this.setData({ loading: true })
    try {
      const result = await callTripManage({ action: "getBlockList" })
      if (!current()) return
      if (result && (result.ok || result.success)) {
        const list = Array.isArray(result.list) ? result.list.map(normalizeItem) : []
        this.setData({ list, loading: false })
        if (!this._hidden) {
          this._refreshTimer = setTimeout(() => { this._refreshTimer = null; this.loadBlockList() }, 240000)
          this._refreshTimer?.unref?.()
        }
        return
      }
      wx.showToast({ title: (result && result.errorMsg) || "加载失败", icon: "none" })
    } catch (err) {
      if (!current()) return
      console.error("loadBlockList failed:", err)
      wx.showToast({ title: "加载失败", icon: "none" })
    }
    this.setData({ list: [], loading: false })
  },

  onUnblockUser(e) {
    const dataset = (e && e.currentTarget && e.currentTarget.dataset) || {}
    const identity = profile.identity()
    const allowed = () => !this._disposed && identity === profile.identity() && identity === this._listIdentity
    if (!allowed()) return
    const target = contacts.target(e)
    const targetId = target.targetUserId
    const targetName = dataset.name || "该用户"
    if (!targetId) return

    wx.showModal({
      title: "解除拉黑",
      content: `解除后，你们可以再次加入彼此的路线。确认解除${targetName}？`,
      confirmText: "解除",
      cancelText: "取消",
      success: async (res) => {
        if (!res.confirm || !allowed()) return
        try {
          wx.showLoading({ title: "正在处理...", mask: true })
          const result = await callTripManage({ action: "unblockUser", ...target })
          wx.hideLoading()
          if (!allowed()) return

          if (result && (result.ok || result.success)) {
            markRideListStale()
            const list = this.data.list.filter(item => item.targetUserId !== targetId)
            this.setData({ list })
            wx.showToast({ title: result.recovered ? "已确认上次操作" : "已解除", icon: "success" })
            return
          }

          wx.showToast({ title: (result && result.errorMsg) || "操作失败", icon: "none" })
        } catch (err) {
          wx.hideLoading()
          if (!allowed()) return
          console.error("unblockUser failed:", err)
          wx.showToast({ title: "操作失败", icon: "none" })
        }
      }
    })
  }
})
