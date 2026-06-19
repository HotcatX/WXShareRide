App({
  onLaunch() {

    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力')
      return
    }

    // 只初始化一次，指定新的测试环境
    wx.cloud.init({
      env: 'cloud1-7gmtcu4s3aebce27',
      traceUser: true
    })

    // 强制重新登录（可保留）
    // wx.clearStorageSync()
  }
})
