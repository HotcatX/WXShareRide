// pages/profile/couponUse/couponUse.js
const { COUPONS, getCouponFileID, resolveToTempURL } = require("../../../utils/coupons")

Page({
  data: {
    statusBarHeight: 0,
    coupon: {}
  },

  onLoad(options) {
    const sys = wx.getSystemInfoSync()
    this.setData({ statusBarHeight: sys.statusBarHeight || 0 })

    const id = decodeURIComponent(options?.id || "")
    this.loadCoupon(id)
  },

  async loadCoupon(id) {
    const base = COUPONS.find(x => x.id === id)
    if (!base) {
      wx.showToast({ title: "找不到该优惠券", icon: "none" })
      return
    }

    // 先渲染文字信息，图片异步加载
    this.setData({ coupon: { ...base, image: "" } })

    const fileID = getCouponFileID(base)
    const tempURL = await resolveToTempURL(fileID)

    this.setData({
      coupon: {
        ...base,
        image: tempURL,       // ✅ couponUse.wxml 用的就是 coupon.image
        imageFileID: fileID   // 方便你调试
      }
    })
  },

  onBack() {
    wx.navigateBack({ delta: 1 })
  },

  onConfirmUse() {
    wx.showToast({ title: "请向商家出示此券", icon: "none" })
  }
})
