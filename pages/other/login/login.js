// pages/other/login/login.js
const referral = require("../../../utils/referral")
const { returnToPublicPage } = require('../../../utils/loginNavigation')

Page({
  data: {
    logging: false,
    privacyAgreed: false
  },

  onUnload() {
    this._leaving = true
    this._loginAttempt = (this._loginAttempt || 0) + 1
  },

  togglePrivacyAgreement() {
    this.setData({
      privacyAgreed: !this.data.privacyAgreed
    })
  },

  backToPending(pendingUrl) {
    // 优先：如果上一页存在，直接返回上一页（通常是从 home navigateTo 进来的）
    const pages = getCurrentPages()
    if (pages.length > 1) {
      wx.navigateBack()
      return
    }

    // 没有上一页：按 url 回跳
    if (pendingUrl) {
      if (pendingUrl === '/pages/home/home') {
        wx.reLaunch({ url: '/pages/home/home' })
        return
      }
      wx.redirectTo({ url: pendingUrl })
      return
    }

    wx.reLaunch({ url: '/pages/home/home' })
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
    if (this.data.logging || this._leaving) return
  
    if (!this.data.privacyAgreed) {
      wx.showToast({
        title: '请先阅读并同意《隐私政策》',
        icon: 'none'
      })
      return
    }
  
    const attempt = this._loginAttempt = (this._loginAttempt || 0) + 1
    const isCurrent = () => !this._leaving && this._loginAttempt === attempt
    this.setData({ logging: true })

    try {
      const cloudRes = await wx.cloud.callFunction({ name: 'login', data: {} })
      if (!isCurrent()) return
      const result = cloudRes.result || {}
      if (!result.ok) throw new Error(result.errorMsg || '登录失败')

      const openid = result.openid || ''
      if (!openid) throw new Error('登录失败：未获取到 openid')

      wx.setStorageSync('openid', openid)
      wx.setStorageSync('isGuest', false)
      require('../../../utils/researchParticipation').identityChanged()
      if (result.referralCode) referral.setMyReferralCode(result.referralCode)
      await referral.bindPendingReferral()
      if (!isCurrent()) return

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
      if (!isCurrent()) return

      if (!completed) {
        // 保留 pendingPage 和 postLoginAction，资料保存后还要返回原路线并继续加入。
        // redirectTo 会用资料页替换登录页，资料页 navigateBack 后直接回到 tripDetail。
        wx.redirectTo({ url: '/pages/profile/addInfo/addInfo?from=login' })
        return
      }


      // 已完成资料或不要求完善：回跳

      const returnUrl = (action && action.returnUrl) ? String(action.returnUrl) : ''
      const shouldResumeAction = action && action.type === 'joinCarpool'
      if (!shouldResumeAction) wx.removeStorageSync('postLoginAction')

      if (pendingUrl) {
        wx.removeStorageSync('pendingPage')
        this.backToPending(pendingUrl)
        return
      }

      if (returnUrl) {
        wx.redirectTo({ url: returnUrl })
        return
      }
      wx.reLaunch({ url: '/pages/home/home' })
    } catch (e) {
      if (isCurrent()) wx.showToast({ title: e.message || '登录失败', icon: 'none' })
    } finally {
      if (isCurrent()) this.setData({ logging: false })
    }
  },

  onGuestTap() {
    if (this._leaving) return
    this._leaving = true
    this._loginAttempt = (this._loginAttempt || 0) + 1
    this.setData({ logging: false })

    wx.setStorageSync('isGuest', true)
    wx.setStorageSync('openid', '')
    require('../../../utils/researchParticipation').identityChanged()
  
    wx.removeStorageSync('postLoginAction')
    wx.removeStorageSync('needLoginToast')
  
    const pending = wx.getStorageSync('pendingPage') || {}
    const pendingUrl = (pending && pending.url) ? String(pending.url) : ''
    wx.removeStorageSync('pendingPage')
  
    returnToPublicPage(pendingUrl)
  },

  goPrivacy() {
    wx.navigateTo({ url: '/pages/other/privacy/privacy' })
  }
})
