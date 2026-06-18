// pages/other/xiangweiyuan/xiangweiyuan.js

// ✅ 你提供的云存储图片 fileID
const POSTER_FILE_ID =
  "cloud://cloud1-7gmtcu4s3aebce27.636c-cloud1-7gmtcu4s3aebce27-1383643768/coupons/restaurant/湘味苑/xiangweiyuan.png.jpeg"

const COUPON_FILE_ID =
  "cloud://cloud1-7gmtcu4s3aebce27.636c-cloud1-7gmtcu4s3aebce27-1383643768/coupons/restaurant/湘味苑/湘味苑.jpg"

Page({
  data: {
    statusBarHeight: 80,
    pageTitle: "餐厅介绍",

    restaurant: {
      headerTop: "",
      name: "Wang's Chinese Cuisine",
      titleCN: "湘味苑",
      subtitle: "工作日，给自己一顿地道湘味的满足时间",
      detailTitle: "详细信息",
      detailLine1: "周一到周四 全场8.5折（特价午餐除外）",
      detailLine2: "到店出示优惠券图片即可使用",
      address: "478 Kinderkamack Rd, River Edge"
    },

    // ✅ 海报
    posterImg: "",
    posterFileID: "",

    // ✅ 优惠券
    couponImg: "",
    couponFileID: ""
  },

  async onLoad() {
    const info = wx.getSystemInfoSync()
    this.setData({ statusBarHeight: info.statusBarHeight })

    // ✅ 默认加载海报
    await this.loadPosterFromCloud()

    // 如需“进页面就显示优惠券”，取消注释
    // await this.loadCouponFromCloud()
  },

  goBack() {
    wx.navigateBack()
  },

  copyAddress() {
    const addr = this.data.restaurant.address || ""
    if (!addr) {
      wx.showToast({ title: "地址未设置", icon: "none" })
      return
    }
    wx.setClipboardData({ data: addr })
  },

  // ---------------- 海报 ----------------
  async loadPosterFromCloud() {
    try {
      const url = await this.getCloudTempURL(POSTER_FILE_ID)
      this.setData({
        posterImg: url,
        posterFileID: POSTER_FILE_ID
      })
    } catch (e) {
      console.warn("加载海报失败：", e)
      wx.showToast({ title: "海报加载失败", icon: "none" })
    }
  },

  async savePoster() {
    const fileID = this.data.posterFileID
    if (!fileID) return

    try {
      wx.showLoading({ title: "保存中..." })
      const res = await this.downloadFromCloud(fileID)
      await this.saveImageToAlbumWithPermission(res.tempFilePath)
      wx.showToast({ title: "已保存到相册", icon: "success" })
    } catch (e) {
      console.error(e)
      wx.showToast({ title: "保存失败（可能未授权）", icon: "none" })
    } finally {
      wx.hideLoading()
    }
  },

  // ---------------- 优惠券 ----------------
  async generateCoupon() {
    try {
      wx.showLoading({ title: "获取中..." })

      const url = await this.getCloudTempURL(COUPON_FILE_ID)

      this.setData({
        couponImg: url,
        couponFileID: COUPON_FILE_ID
      })

      wx.setStorageSync("xiangweiyuan_coupon_cloud", {
        fileID: COUPON_FILE_ID,
        savedAt: Date.now()
      })

      wx.showToast({ title: "已获取优惠券", icon: "success" })
    } catch (e) {
      console.error(e)
      wx.showToast({ title: "获取失败，请重试", icon: "none" })
    } finally {
      wx.hideLoading()
    }
  },

  async loadCouponFromCloud() {
    try {
      const saved = wx.getStorageSync("xiangweiyuan_coupon_cloud")
      const fileID = saved?.fileID || COUPON_FILE_ID
      const url = await this.getCloudTempURL(fileID)
      this.setData({ couponImg: url, couponFileID: fileID })
    } catch (e) {
      console.warn("恢复优惠券失败：", e)
    }
  },

  async saveCoupon() {
    const fileID = this.data.couponFileID
    if (!fileID) return

    try {
      wx.showLoading({ title: "保存中..." })
      const res = await this.downloadFromCloud(fileID)
      await this.saveImageToAlbumWithPermission(res.tempFilePath)
      wx.showToast({ title: "已保存到相册", icon: "success" })
    } catch (e) {
      console.error(e)
      wx.showToast({ title: "保存失败（可能未授权）", icon: "none" })
    } finally {
      wx.hideLoading()
    }
  },

  clearCoupon() {
    wx.removeStorageSync("xiangweiyuan_coupon_cloud")
    this.setData({ couponImg: "", couponFileID: "" })
    wx.showToast({ title: "已清除", icon: "success" })
  },

  // -------- 云能力 --------
  getCloudTempURL(fileID) {
    return new Promise((resolve, reject) => {
      wx.cloud.getTempFileURL({
        fileList: [fileID],
        success: (res) => {
          const item = res.fileList?.[0]
          item?.tempFileURL ? resolve(item.tempFileURL) : reject()
        },
        fail: reject
      })
    })
  },

  downloadFromCloud(fileID) {
    return new Promise((resolve, reject) => {
      wx.cloud.downloadFile({
        fileID,
        success: resolve,
        fail: reject
      })
    })
  },

  // -------- 相册权限 --------
  async saveImageToAlbumWithPermission(filePath) {
    const auth = (await this.getSetting())["scope.writePhotosAlbum"]
    if (auth === false) await this.openSettingForAlbum()
    else if (auth !== true) await this.authorizeAlbum()

    return new Promise((resolve, reject) => {
      wx.saveImageToPhotosAlbum({ filePath, success: resolve, fail: reject })
    })
  },

  getSetting() {
    return new Promise((resolve) => {
      wx.getSetting({ success: (res) => resolve(res.authSetting || {}) })
    })
  },

  authorizeAlbum() {
    return new Promise((resolve, reject) => {
      wx.authorize({
        scope: "scope.writePhotosAlbum",
        success: resolve,
        fail: reject
      })
    })
  },

  openSettingForAlbum() {
    return new Promise((resolve, reject) => {
      wx.showModal({
        title: "需要授权",
        content: "保存到相册需要相册权限，请在设置中开启。",
        success: (res) => {
          if (!res.confirm) return reject()
          wx.openSetting({ success: resolve, fail: reject })
        }
      })
    })
  }
})
