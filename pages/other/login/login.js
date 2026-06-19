// pages/other/login/login.js
Page({
  data: { logging: false },

  backToPending(pendingUrl) {
    // 优先：如果上一页存在，直接返回上一页（通常是从 home navigateTo 进来的）
    const pages = getCurrentPages()
    if (pages.length > 1) {
      wx.navigateBack()
      return
    }

    // 没有上一页：按 url 回跳
    if (pendingUrl) {
      // 你的主界面 home 是 tabBar，必须用 switchTab
      if (pendingUrl === '/pages/home/home') {
        wx.switchTab({ url: '/pages/home/home' })
        return
      }
      wx.redirectTo({ url: pendingUrl })
      return
    }

    wx.switchTab({ url: '/pages/home/home' })
  },

  // 兼容不同 getUserInfo 返回结构；只认可 profileCompleted === true 才算完成
  async isProfileCompleted() {
    const res = await wx.cloud.callFunction({ name: 'getUserInfo' })
    const r = (res && res.result) ? res.result : {}

    // 常见几种结构都兼容一下
    // 1) r.data = [doc]
    // 2) r.data = doc
    // 3) r.userInfo = doc
    // 4) r.user = doc
    let doc = null

    if (Array.isArray(r.data)) doc = r.data[0] || null
    else if (r.data && typeof r.data === 'object') doc = r.data
    else if (r.userInfo && typeof r.userInfo === 'object') doc = r.userInfo
    else if (r.user && typeof r.user === 'object') doc = r.user

    // 没有 doc：一定未完成
    if (!doc) return false

    // 兼容两种字段名：profileCompleted / profileComplete
    const v = (doc.profileCompleted !== undefined) ? doc.profileCompleted : doc.profileComplete
    return v === true

  },

  async onLoginTap() {
    if (this.data.logging) return
    this.setData({ logging: true })

    try {
      const cloudRes = await wx.cloud.callFunction({ name: 'login', data: {} })
      const result = cloudRes.result || {}
      if (!result.ok) throw new Error(result.errorMsg || '登录失败')

      const openid = result.openid || ''
      if (!openid) throw new Error('登录失败：未获取到 openid')

      wx.setStorageSync('openid', openid)
      wx.setStorageSync('isGuest', false)

      const action = wx.getStorageSync('postLoginAction') || {}
      const pending = wx.getStorageSync('pendingPage') || {}
      const pendingUrl = (pending && pending.url) ? String(pending.url) : ''

      // 强制完善资料的触发条件：
      // 1) 明确要求补全资料
      // ✅ 微信登录后：强制检查一次资料是否完成（最符合你“新用户必须补资料”的要求）
      let completed = false
      try {
        completed = await this.isProfileCompleted()
      } catch (e) {
        completed = false
      }

      if (!completed) {
        // 不清 pendingPage：addInfo 保存后需要回跳
        wx.removeStorageSync('postLoginAction')
        wx.navigateTo({ url: '/pages/profile/addInfo/addInfo?from=login' })
        return
      }


      // 已完成资料或不要求完善：回跳

      const returnUrl = (action && action.returnUrl) ? String(action.returnUrl) : ''
      wx.removeStorageSync('postLoginAction')

      if (pendingUrl) {
        wx.removeStorageSync('pendingPage')
        this.backToPending(pendingUrl) // 你文件里已经有兼容 switchTab 的 backToPending
        return
      }

      if (returnUrl) {
        wx.redirectTo({ url: returnUrl })
        return
      }
      wx.switchTab({ url: '/pages/home/home' })
    } catch (e) {
      wx.showToast({ title: e.message || '登录失败', icon: 'none' })
    } finally {
      this.setData({ logging: false })
    }
  },

  onGuestTap() {
    wx.setStorageSync('isGuest', true)
    wx.setStorageSync('openid', '')

    wx.removeStorageSync('postLoginAction')

    const pending = wx.getStorageSync('pendingPage') || {}
    const pendingUrl = (pending && pending.url) ? String(pending.url) : ''
    wx.removeStorageSync('pendingPage')

    this.backToPending(pendingUrl)
  },

  goPrivacy() {
    wx.navigateTo({ url: '/pages/other/privacy/privacy' })
  }
})
