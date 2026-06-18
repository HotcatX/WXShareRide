Page({
  data: {
    statusBarHeight: 0
  },

  onLoad() {
    const sys = wx.getSystemInfoSync()
    this.setData({ statusBarHeight: sys.statusBarHeight || 0 })
  },

  onBack() {
    wx.navigateBack({ delta: 1 })
  }
})
