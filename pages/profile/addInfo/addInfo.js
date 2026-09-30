// pages/profile/addInfo/addInfo.js
const defaultAvatarUrl = 'https://mmbiz.qpic.cn/mmbiz/icTdbqWNOwNRna42FI242Lcia07jQodd2FJGIYQfG0LAJGFxM4FbnQP6yfMxBgJ0F3YRqJCJ1aPAK2dQagdusBZg/0'
const { showDataError } = require('../../../utils/error')
const profileApi = require('../../../utils/compat/profile')
const { resolveProfileAvatar } = require('../../../utils/profileDisplay')
const { callUpdateUser } = require('../../../utils/userProfileUpdate')
const { returnToPublicPage } = require('../../../utils/loginNavigation')

Page({
  data: {
    from: '',
    wechat: '',
    phone: '',               // ⭐ 手机号改成选填
    regionIndex: 0,
    regions: ['美国', '中国大陆'],
    statusBarHeight: 80,
    pageTitle: "请完成以下信息",

    name: '',
    avatarUrl: defaultAvatarUrl,
    zelleName: '',
    zelleAccount: '',
    unsaved: false,
    saving: false
  },

  onLoad(options = {}) {
    this._disposed = false
    this._profileIdentity = profileApi.identity()
    this._exiting = false
    const info = typeof wx.getWindowInfo === "function" ? wx.getWindowInfo() : wx.getSystemInfoSync()
    this.setData({
      statusBarHeight: info.statusBarHeight
    })

    const from = options.from || 'login'
    this.setData({ from })

    // 拉取云端 userInfo
    this.loadUserInfo()
  },

  isProfileCurrent() {
    const identity = profileApi.identity()
    if (this._profileIdentity === undefined) this._profileIdentity = identity
    return !this._disposed && !this._exiting && this._profileIdentity === identity
  },

  onUnload() {
    this._disposed = true
    this.invalidateCompletion()
  },

  invalidateCompletion() {
    this._completionVersion = (this._completionVersion || 0) + 1
    if (this._completionTimer) clearTimeout(this._completionTimer)
    this._completionTimer = null
  },

  onSkipProfile() {
    if (this._exiting || this._disposed) return
    this._exiting = true
    this.invalidateCompletion()
    const pending = wx.getStorageSync('pendingPage') || {}
    wx.removeStorageSync('pendingPage')
    wx.removeStorageSync('postLoginAction')
    wx.removeStorageSync('needLoginToast')
    // Keep the signed-in identity, but never resume a cancelled booking action.
    // A save already sent cannot be recalled; its result must not navigate later.
    returnToPublicPage(typeof pending.url === 'string' ? pending.url : '')
  },

  // Only the latest selected image may change the profile reference.
  async onChooseAvatar(e) {
    if (!this.isProfileCurrent()) return
    const filePath = (e.detail || {}).avatarUrl
    if (!filePath) return
    const selection = this._avatarSelection = (this._avatarSelection || 0) + 1
    const isCurrent = () => this.isProfileCurrent() && this._avatarSelection === selection
    this._avatarUploading = true
    this._editVersion = (this._editVersion || 0) + 1
    try {
      const image = await profileApi.uploadAvatar(filePath)
      if (!isCurrent()) return
      this.setData({ ...image, unsaved: true })
    } catch (_) {
      if (isCurrent()) wx.showToast({ title: '头像上传失败，请重试', icon: 'none' })
    } finally {
      if (isCurrent()) this._avatarUploading = false
    }
  },

  // 拉取云端现有 userInfo
  async loadUserInfo() {
    if (!this.isProfileCurrent()) return
    try {
      const request = this._profileLoad = (this._profileLoad || 0) + 1
      const editVersion = this._editVersion || 0
      const isCurrent = () => this.isProfileCurrent() && this._profileLoad === request &&
        (this._editVersion || 0) === editVersion && !this.data.unsaved
      const res = await profileApi.getUserInfo()
      if (!isCurrent()) return
      if (this._exiting || this._disposed || this.data.unsaved) return
      if (res.result && res.result.data && res.result.data.length > 0) {
        const user = res.result.data[0]
        const avatarUrl = await resolveProfileAvatar(user, defaultAvatarUrl)
        if (!isCurrent()) return
        this.setData({
          wechat: user.wechatID || '',
          phone: user.phone || '',               // ⭐ 若无则为空（选填）
          regionIndex: ((user.regionPhone || user.region) === 'CN') ? 1 : 0,
          name: user.name || '',
          avatarUrl,
          avatarFileId: user.avatarFileId || null,
          zelleName: user.zelleName || '',
          zelleAccount: user.zelleAccount || ''
        })
      }
    } catch (e) {
      console.error('loadUserInfo 失败：', e)
    }
  },

  onInput(e) {
    this._editVersion = (this._editVersion || 0) + 1
    const { field } = e.currentTarget.dataset
    this.setData({ [field]: e.detail.value, unsaved: true })
  },

  onRegionChange(e) {
    this.setData({ regionIndex: e.detail.value, unsaved: true })
  },

  // ⭐ 新校验：微信号必填；手机号为选填
  validateAll() {
    const { wechat, phone, regionIndex } = this.data

    if (!wechat) return '请填写微信号'

    // ⭐ 手机号为选填：如果填写，则校验格式；否则不校验
    if (phone) {
      if (Number(regionIndex) === 0 && !/^\d{10}$/.test(phone)) return '请输入正确美国手机号'
      if (Number(regionIndex) === 1 && !/^1\d{10}$/.test(phone)) return '请输入正确大陆手机号'
    }

    return ''
  },

  async onComplete() {
    if (!this.isProfileCurrent() || this.data.saving) return
    if (this._avatarUploading) {
      wx.showToast({ title: '头像上传中，请稍后保存', icon: 'none' })
      return
    }
    const msg = this.validateAll()
    if (msg) {
      wx.showToast({ title: msg, icon: 'none', duration: 2000 })
      return
    }

    const version = this._completionVersion = (this._completionVersion || 0) + 1
    const isCurrent = () => this.isProfileCurrent() && this._completionVersion === version
    this.setData({ saving: true })
    const ok = await this.saveToCloud(isCurrent)
    if (!isCurrent()) return
    if (!ok) {
      this.setData({ saving: false })
      return
    }

    wx.showToast({ title: '信息已完善', icon: 'success', duration: 800 })

    this._completionTimer = setTimeout(() => {
      this._completionTimer = null
      if (!isCurrent()) return
      const pending = wx.getStorageSync('pendingPage')
      const pages = getCurrentPages()
      const len = pages.length
      const prev = len >= 2 ? pages[len - 2] : null
      const prev2 = len >= 3 ? pages[len - 3] : null

      // 典型：业务页触发登录 -> login -> addInfo
      if (prev && prev.route === 'pages/other/login/login' && prev2) {
        wx.removeStorageSync('pendingPage')
        wx.removeStorageSync('postLoginAction')

        wx.navigateBack({ delta: 2 })
        return
      }

      // ⭐⭐ 其他情况：仍然优先跳回 pendingPage（即原分享界面/业务界面）
      if (pending && pending.url) {
        const url = pending.url
        wx.removeStorageSync('pendingPage')
        wx.removeStorageSync('postLoginAction')
        wx.redirectTo({ url })
        return
      }

      // 没有 pendingPage 时，按来源决定去向
      if (this.data.from === 'login') {
        wx.reLaunch({ url: '/pages/home/home' })
      } else {
        if (pages.length > 1) {
          wx.navigateBack()
        } else {
          wx.reLaunch({ url: '/pages/home/home' })
        }
      }
    }, 800)

  },

  async saveToCloud(isCurrent = () => this.isProfileCurrent()) {
    if (!isCurrent()) return false
    const { wechat, phone, regionIndex } = this.data
    const region = Number(regionIndex) === 0 ? 'US' : 'CN'
    const updateData = {}

    // wechatID（必填）
    if (wechat) {
      updateData.wechatID = wechat
    }

    // ⭐ phone 为选填：若用户填了并合法，才写入云端
    if (phone) {
      const cnValid = region === 'CN' && /^1\d{10}$/.test(phone)
      const usValid = region === 'US' && /^\d{10}$/.test(phone)

      if (cnValid || usValid) {
        updateData.phone = phone
      }
    }

    updateData.regionPhone = region

    // 写入其他字段
    updateData.name = this.data.name || ''
    Object.assign(updateData, profileApi.avatarPatch(this.data))
    updateData.zelleName = this.data.zelleName || ''
    updateData.zelleAccount = this.data.zelleAccount || ''

    if (Object.keys(updateData).length === 0) {
      wx.showToast({ title: '请先填写正确信息', icon: 'none' })
      return false
    }

    try {
      const res = await callUpdateUser(updateData)
      if (!isCurrent()) return false
      const result = res.result || {}
      if (!result.ok) {
        wx.showToast({ title: result.errorMsg || '保存失败', icon: 'none' })
        return false
      }

      this.setData({ unsaved: false })
      return true

    } catch (e) {
      if (!isCurrent()) return false
      console.error('updateUser 调用失败：', e)
      showDataError('保存失败', e, '个人资料保存到数据库失败，请稍后重试。')
      return false
    }
  }
})
