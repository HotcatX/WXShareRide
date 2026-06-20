Page({
  data: {
    email: '',
    regionOptions: ['中国大陆 +86', '美国 +1'],
    regionCode: '+86',
    regionLabel: '中国大陆 +86',
    phone: '',
    content: '',
    statusBarHeight: 80,  // 默认值，防止闪烁
    pageTitle: "联系开发者", // 页面标题可修改

    // ⭐ 自定义横排 Toast 状态
    toastVisible: false,
    toastText: '',
    toastType: 'success',  // 'success' | 'error' | 'warn'
    toastIcon: ''          // '✓' / '!' / '✕'
  },

  // ⭐ 横排提示条
  showToastBar(text, type = 'success') {
    const icon = type === 'success' ? '✓' : (type === 'warn' ? '!' : '✕')

    this.setData({
      toastVisible: true,
      toastText: text,
      toastType: type,
      toastIcon: icon
    })

    if (this._toastTimer) clearTimeout(this._toastTimer)
    this._toastTimer = setTimeout(() => {
      this.setData({ toastVisible: false })
      this._toastTimer = null
    }, 2000)
  },

  onUnload() {
    if (this._toastTimer) clearTimeout(this._toastTimer)
  },

  onLoad() {
    const info = typeof wx.getWindowInfo === "function" ? wx.getWindowInfo() : wx.getSystemInfoSync()
    this.setData({
      statusBarHeight: info.statusBarHeight
    })
  },

  goBack() {
    wx.navigateBack()
  },

  onEmailInput(e) {
    this.setData({ email: e.detail.value })
  },

  onRegionChange(e) {
    const index = e.detail.value
    const selected = this.data.regionOptions[index]
    const code = selected.includes('+1') ? '+1' : '+86'
    this.setData({
      regionLabel: selected,
      regionCode: code
    })
  },

  onPhoneInput(e) {
    this.setData({ phone: e.detail.value })
  },

  onContentInput(e) {
    this.setData({ content: e.detail.value })
  },

  submitFeedback() {
    const { email, phone, regionCode, content } = this.data

    // 1️⃣ 表单完整性验证
    if (!email || !phone || !content) {
      this.showToastBar('请填写完整信息', 'error')
      return
    }

    // 2️⃣ 邮箱格式验证
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(email)) {
      this.showToastBar('邮箱格式不正确', 'error')
      return
    }

    // 3️⃣ 手机号验证（根据地区不同）
    let phoneRegex
    if (regionCode === '+86') {
      phoneRegex = /^1[3-9]\d{9}$/   // 中国大陆手机号
    } else if (regionCode === '+1') {
      phoneRegex = /^[2-9]\d{2}[2-9]\d{6}$/  // 美国手机号（10位）
    }

    if (!phoneRegex || !phoneRegex.test(phone)) {
      this.showToastBar(
        regionCode === '+86' ? '手机号格式错误（大陆）' : '手机号格式错误（美国）',
        'error'
      )
      return
    }

    // 4️⃣ 上传数据库
    const db = wx.cloud.database()
    db.collection('feedback').add({
      data: {
        email,
        phone,
        region: regionCode,
        content,
        createTime: new Date()
      },
      success: () => {
        // ✅ 提交成功使用系统默认 toast
        wx.showToast({ title: '提交成功', icon: 'success' })
        this.setData({
          email: '',
          phone: '',
          content: '',
          regionLabel: '中国大陆 +86',
          regionCode: '+86'
        })
      },
      fail: (err) => {
        console.error(err)
        wx.showToast({ title: '提交失败，请稍后重试', icon: 'none' })
      }
    })
  }
})
