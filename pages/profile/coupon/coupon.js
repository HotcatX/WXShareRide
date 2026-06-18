// pages/profile/coupon/coupon.js
const { COUPONS } = require("../../../utils/coupons")

Page({
  data: {
    statusBarHeight: 0,
    activeTab: "all",
    list: COUPONS,
    displayList: COUPONS
  },

  onLoad() {
    const sys = wx.getSystemInfoSync()
    this.setData({ statusBarHeight: sys.statusBarHeight || 0 })
  },

  onPullDownRefresh() {
    this.applyFilter()
    wx.stopPullDownRefresh()
  },

  onBack() {
    wx.navigateBack({ delta: 1 })
  },

  setTab(e) {
    const tab = e.currentTarget.dataset.tab
    this.setData({ activeTab: tab }, () => this.applyFilter())
  },

  applyFilter() {
    const tab = this.data.activeTab
    const all = this.data.list || []
    const display = tab === "all" ? all : all.filter(x => x.category === tab)
    this.setData({ displayList: display })
  },

  onUse(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: `/pages/profile/couponUse/couponUse?id=${encodeURIComponent(id)}` })
  }
})
