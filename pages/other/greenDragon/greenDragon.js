const POSTER_FILE_ID =
  "cloud://cloud1-7gmtcu4s3aebce27.636c-cloud1-7gmtcu4s3aebce27-1383643768/coupons/restaurant/Green Dragon/IMG_7730.jpg"

const COUPON_FILE_ID =
  "cloud://cloud1-7gmtcu4s3aebce27.636c-cloud1-7gmtcu4s3aebce27-1383643768/coupons/restaurant/Green Dragon/Green Dragon.jpg"

const LOG_DOC_ID = "GreenDragon"

Page({
  data: {
    statusBarHeight: 80,
    pageTitle: "餐厅介绍",

    restaurant: {
      headerTop: "",
      name: "Green Dragon",
      titleCN: "绿龙烧烤",
      subtitle: "工作日，给自己一顿热乎的家常味道",
      detailTitle: "详细信息",
      detailLine1: "周一到周四全天享9折优惠",
      detailLine2: "到店出示优惠券图片即可使用",
      address: "1041 River Rd, New Milford, NJ 07646"
    },

    posterImg: "",
    posterFileID: "",

    couponImg: "",
    couponFileID: ""
  },

  async onLoad() {
    const info = wx.getSystemInfoSync()
    this.setData({ statusBarHeight: info.statusBarHeight })

    await this.loadPosterFromCloud()

    this.logAction("enter")

  },

  logAction(action) {
    if (!wx.cloud || !wx.cloud.callFunction) return

    wx.cloud
      .callFunction({
        name: "logCounter",
        data: {
          _id: LOG_DOC_ID, // ✅ 写到 GreenDragon 记录
          action // "enter" | "generateCoupon"
        }
      })
      .then((res) => {
        console.log("[logCounter success]", LOG_DOC_ID, action, res)
      })
      .catch((err) => {
        console.error("[logCounter error]", LOG_DOC_ID, action, err)
      })
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

  // ---------------- 海报：云端获取并展示 ----------------
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
      const downloadRes = await this.downloadFromCloud(fileID)
      await this.saveImageToAlbumWithPermission(downloadRes.tempFilePath)
      wx.showToast({ title: "已保存到相册", icon: "success" })
    } catch (e) {
      console.error("保存海报失败：", e)
      wx.showToast({ title: "保存失败（可能未授权）", icon: "none" })
    } finally {
      wx.hideLoading()
    }
  },

  // ---------------- 优惠券：云端获取并展示 ----------------
  async generateCoupon() {
    try {
      wx.showLoading({ title: "获取中..." })

      const url = await this.getCloudTempURL(COUPON_FILE_ID)

      this.setData({
        couponImg: url,
        couponFileID: COUPON_FILE_ID
      })

      wx.setStorageSync("xiaochuandian_coupon_cloud", {
        fileID: COUPON_FILE_ID,
        savedAt: Date.now()
      })

      wx.showToast({ title: "已获取优惠券", icon: "success" })

      // ✅ 统计“点击生成优惠券”的次数（成功后再记）
      this.logAction("generateCoupon")
    } catch (e) {
      console.error("获取优惠券失败：", e)
      wx.showToast({ title: "获取失败，请重试", icon: "none" })
    } finally {
      wx.hideLoading()
    }
  },

  async loadCouponFromCloud() {
    try {
      const saved = wx.getStorageSync("xiaochuandian_coupon_cloud")
      const fileID = saved && saved.fileID ? saved.fileID : COUPON_FILE_ID
      const url = await this.getCloudTempURL(fileID)
      this.setData({ couponImg: url, couponFileID: fileID })
    } catch (e) {
      console.warn("恢复云端优惠券失败：", e)
    }
  },

  async saveCoupon() {
    const fileID = this.data.couponFileID
    if (!fileID) return

    try {
      wx.showLoading({ title: "保存中..." })
      const downloadRes = await this.downloadFromCloud(fileID)
      await this.saveImageToAlbumWithPermission(downloadRes.tempFilePath)
      wx.showToast({ title: "已保存到相册", icon: "success" })
    } catch (e) {
      console.error("保存优惠券失败：", e)
      wx.showToast({ title: "保存失败（可能未授权）", icon: "none" })
    } finally {
      wx.hideLoading()
    }
  },

  clearCoupon() {
    try {
      wx.removeStorageSync("xiaochuandian_coupon_cloud")
      this.setData({ couponImg: "", couponFileID: "" })
      wx.showToast({ title: "已清除", icon: "success" })
    } catch (e) {
      console.error(e)
      wx.showToast({ title: "清除失败", icon: "none" })
    }
  },

  // -------- 云能力：取临时 URL / 下载 ----------
  getCloudTempURL(fileID) {
    return new Promise((resolve, reject) => {
      if (!wx.cloud || !wx.cloud.getTempFileURL) {
        reject(new Error("wx.cloud 未初始化，请确认 app.js 已 wx.cloud.init"))
        return
      }
      wx.cloud.getTempFileURL({
        fileList: [fileID],
        success: (res) => {
          const item = (res.fileList || [])[0]
          if (item && item.tempFileURL) resolve(item.tempFileURL)
          else reject(new Error("getTempFileURL 返回为空"))
        },
        fail: reject
      })
    })
  },

  downloadFromCloud(fileID) {
    return new Promise((resolve, reject) => {
      if (!wx.cloud || !wx.cloud.downloadFile) {
        reject(new Error("wx.cloud 未初始化，请确认 app.js 已 wx.cloud.init"))
        return
      }
      wx.cloud.downloadFile({
        fileID,
        success: resolve,
        fail: reject
      })
    })
  },

  // -------- 保存相册权限处理 ----------
  async saveImageToAlbumWithPermission(filePath) {
    const auth = await this.getSetting()
    const has = auth["scope.writePhotosAlbum"]

    if (has === false) {
      await this.openSettingForAlbum()
    } else if (has !== true) {
      await this.authorizeAlbum()
    }

    return new Promise((resolve, reject) => {
      wx.saveImageToPhotosAlbum({
        filePath,
        success: resolve,
        fail: reject
      })
    })
  },

  getSetting() {
    return new Promise((resolve) => {
      wx.getSetting({
        success: (res) => resolve(res.authSetting || {}),
        fail: () => resolve({})
      })
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
        content: "保存到相册需要相册权限，请在设置中开启“保存到相册”。",
        success: (res) => {
          if (!res.confirm) return reject(new Error("user_cancel"))
          wx.openSetting({ success: resolve, fail: reject })
        }
      })
    })
  }
})