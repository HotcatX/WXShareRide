const POSTER_FILE_ID =
  "cloud://cloud1-7gmtcu4s3aebce27.636c-cloud1-7gmtcu4s3aebce27-1383643768/coupons/entertainment/Lash Atelier/Lash Atelier.jpeg"

Page({
  data: {
    statusBarHeight: 80,
    pageTitle: "活动介绍",

    restaurant: {
      headerTop: "",
      name: "Lash Atelier",
      titleCN: "新中式美睫",
      subtitle: "工作日，给自己一顿热乎的家常味道",
      detailTitle: "详细信息",
      detailLine1: "电话预约 所有款式$99（不包含加项）",
      detailLine2: "到店出示本页面即可获得优惠",
      address: "442 Main Street 2楼 2A，Fort Lee，NJ 07024"
    },

    // ✅ 海报展示用临时 URL + fileID
    posterImg: "",
    posterFileID: ""
  },

  async onLoad() {
    const info = wx.getSystemInfoSync()
    this.setData({ statusBarHeight: info.statusBarHeight })

    // ✅ 默认加载海报
    await this.loadPosterFromCloud()

    // ✅ 统计进入页面次数（不阻塞页面）
    this.logAction("enter")
  },

  // ✅ 统计：封装调用云函数（Log/_id = LashAtelier 自增）
  logAction(action) {
    // 统计失败不影响主流程
    if (!wx.cloud || !wx.cloud.callFunction) return

    wx.cloud
      .callFunction({
        name: "logCounter",
        data: {
          _id: "LashAtelier",
          action // "enter" | "copyWechat"
        }
      })
      .catch((err) => {
        console.warn("logCounter failed:", action, err)
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

  copyWechat() {
    const wechat = "NaomiEyelash"
    wx.setClipboardData({
      data: wechat,
      success: () => {
        wx.showToast({
          title: "微信号已复制",
          icon: "success"
        })

        // ✅ 统计复制微信次数
        this.logAction("copyWechat")
      }
    })
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