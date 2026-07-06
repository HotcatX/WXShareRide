// pages/profile/addInfo/addInfo.js
const defaultAvatarUrl = 'https://mmbiz.qpic.cn/mmbiz/icTdbqWNOwNRna42FI242Lcia07jQodd2FJGIYQfG0LAJGFxM4FbnQP6yfMxBgJ0F3YRqJCJ1aPAK2dQagdusBZg/0'
const { showDataError } = require('../../../utils/error')

Page({
  data: {
    from: '',
    wechat: '',
    phone: '',               // ⭐ 手机号改成选填
    regionIndex: 0,
    regionPhone: ['美国', '中国大陆'],
    statusBarHeight: 80,
    pageTitle: "请完成以下信息",

    name: '',
    avatarUrl: defaultAvatarUrl,
    zelleName: '',
    zelleAccount: '',
    unsaved: false
  },

  onLoad(options) {
    const info = typeof wx.getWindowInfo === "function" ? wx.getWindowInfo() : wx.getSystemInfoSync()
    this.setData({
      statusBarHeight: info.statusBarHeight
    })

    const from = options.from || 'login'
    this.setData({ from })

    // 拉取云端 userInfo
    this.loadUserInfo()
  },

  // 上传头像
  async onChooseAvatar(e) {
    const { avatarUrl } = e.detail || {}
    if (!avatarUrl) return


    try {
      const extMatch = avatarUrl.match(/\.(\w+)$/)
      const ext = extMatch ? extMatch[1] : 'jpg'
      const cloudPath = `userAvatar/${Date.now()}-${Math.floor(Math.random() * 1000000)}.${ext}`

      const uploadRes = await wx.cloud.uploadFile({
        cloudPath,
        filePath: avatarUrl
      })

      this.setData({
        avatarUrl: uploadRes.fileID,
        unsaved: true
      })
    } catch (err) {
      console.error('上传头像失败：', err)
      wx.showToast({ title: '头像上传失败，请重试', icon: 'none' })
    } finally {
    }
  },

  // 拉取云端现有 userInfo
  async loadUserInfo() {
    try {
      const res = await wx.cloud.callFunction({ name: 'getUserInfo' })
      if (res.result && res.result.data && res.result.data.length > 0) {
        const user = res.result.data[0]
        this.setData({
          wechat: user.wechatID || '',
          phone: user.phone || '',               // ⭐ 若无则为空（选填）
          regionIndex: (user.regionPhone === 'CN') ? 1 : 0,
          name: user.name || '',
          avatarUrl: user.avatarUrl || this.data.avatarUrl,
          zelleName: user.zelleName || '',
          zelleAccount: user.zelleAccount || ''
        })
      }
    } catch (e) {
      console.error('loadUserInfo 失败：', e)
    }
  },

  onInput(e) {
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
      if (regionIndex === 0 && !/^\d{10}$/.test(phone)) return '请输入正确美国手机号'
      if (regionIndex === 1 && !/^1\d{10}$/.test(phone)) return '请输入正确大陆手机号'
    }

    return ''
  },

  async onComplete() {
    const msg = this.validateAll()
    if (msg) {
      wx.showToast({ title: msg, icon: 'none', duration: 2000 })
      return
    }

    const ok = await this.saveToCloud()
    if (!ok) {
      return
    }

    wx.showToast({ title: '信息已完善', icon: 'success', duration: 800 })

    setTimeout(() => {
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

  async saveToCloud() {
    const { wechat, phone, regionIndex, address } = this.data
    const region = regionIndex === 0 ? 'US' : 'CN'
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
        updateData.region = region
      }
    }

    updateData.address = address || ''

    // 写入其他字段
    updateData.name = this.data.name || ''
    updateData.avatarUrl = this.data.avatarUrl || ''
    updateData.zelleName = this.data.zelleName || ''
    updateData.zelleAccount = this.data.zelleAccount || ''

    if (Object.keys(updateData).length === 0) {
      wx.showToast({ title: '请先填写正确信息', icon: 'none' })
      return false
    }

    try {
      const res = await wx.cloud.callFunction({
        name: 'updateUser',
        data: updateData
      })
      const result = res.result || {}
      if (!result.ok) {
        wx.showToast({ title: result.errorMsg || '保存失败', icon: 'none' })
        return false
      }

      this.setData({ unsaved: false })
      return true

    } catch (e) {
      console.error('updateUser 调用失败：', e)
      showDataError('保存失败', e, '个人资料保存到数据库失败，请稍后重试。')
      return false
    }
  }
})
