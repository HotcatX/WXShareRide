const { callTripManage } = require("../../../utils/tripManage")

Page({
  data: {
    statusBarHeight: 80,

    type: 'carpool',
    tripId: '',
    action: '', // deleteTrip | kickPassenger
    targetOpenid: '',

    pageTitle: '',
    questionTitle: '',
    confirmText: '',

    reasons: [],
    selectedReason: '',
    otherReason: '',

    submitting: false
  },

  onLoad(options) {
    const info = typeof wx.getWindowInfo === "function"
      ? wx.getWindowInfo()
      : wx.getSystemInfoSync()

      const tripId = options.tripId || ''
      const action = options.action || ''
      const targetOpenid = options.targetOpenid || ''
      const sourceType = options.sourceType || options.type || 'carpool'

    if (!tripId || !action) {
      wx.showToast({ title: '参数错误', icon: 'none' })
      return
    }

    if (action === 'deleteTrip') {
      this.setData({
        statusBarHeight: info.statusBarHeight,
        tripId,
        action,
        targetOpenid,
        pageTitle: '删除路线原因',
        questionTitle: '为什么要删除这条路线？',
        confirmText: '提交并删除路线',
        reasons: [
          '误创行程',
          '早晚时间弄反了',
          '起始地点弄反了',
          '时间/地点填写错误',
          '联系方式有误',
          '本人出行计划有变',
          '其他'
        ]
      })
    } else if (action === 'kickPassenger') {
      this.setData({
        statusBarHeight: info.statusBarHeight,
        tripId,
        action,
        targetOpenid,
        pageTitle: '剔除乘客原因',
        questionTitle: '为什么要剔除该乘客？',
        confirmText: '提交并剔除乘客',
        reasons: [
          '联系不上乘客',
          '乘客联系方式有误',
          '乘客上下车地点不合适',
          '乘客临时改时间',
          '乘客临时改地点',
          '双方协商取消',
          '其他'
        ]
      })
    } else if (action === 'quitTrip') {
    this.setData({
      statusBarHeight: info.statusBarHeight,
      tripId,
      action,
      sourceType,
      targetOpenid,
      pageTitle: '退出路线原因',
      questionTitle: '为什么要退出这条路线？',
      confirmText: '提交并退出路线',
      reasons: [
        '误加行程',
        '本人出行计划有变',
        '时间地点不合适',
        '联系不上司机',
        '司机联系方式有误',
        '已找到其他出行方式',
        '其他'
      ]
    })
  }
    else {
      wx.showToast({ title: '操作类型错误', icon: 'none' })
    }
  },

  goBack() {
    wx.navigateBack()
  },

  onSelectReason(e) {
    const reason = e.currentTarget.dataset.reason || ''
    this.setData({
      selectedReason: reason,
      otherReason: reason === '其他' ? this.data.otherReason : ''
    })
  },

  onOtherReasonInput(e) {
    this.setData({
      otherReason: e.detail.value || ''
    })
  },

  getFinalReason() {
    const { selectedReason, otherReason } = this.data

    if (selectedReason === '其他') {
      return String(otherReason || '').trim()
    }

    return selectedReason
  },

  validateForm() {
    const { selectedReason, otherReason } = this.data

    if (!selectedReason) {
      wx.showToast({ title: '请选择原因', icon: 'none' })
      return false
    }

    if (selectedReason === '其他' && !String(otherReason || '').trim()) {
      wx.showToast({ title: '请填写具体原因', icon: 'none' })
      return false
    }

    return true
  },

  async onSubmit() {
    if (this.data.submitting) return
    if (!this.validateForm()) return

    const { action } = this.data
    const finalReason = this.getFinalReason()

    let title = ''
    let content = ''
    let confirmText = ''

    if (action === 'deleteTrip') {
      title = '确认删除路线'
      content = '提交后将删除路线，确认继续？'
      confirmText = '确认删除'

    } else if (action === 'kickPassenger') {
      title = '确认剔除乘客'
      content = '提交后将剔除该乘客，确认继续？'
      confirmText = '确认剔除'

    } else if (action === 'quitTrip') {
      title = '确认退出路线'
      content = '提交后将退出该路线，确认继续？'
      confirmText = '确认退出'
    }

    wx.showModal({
      title,
      content,
      confirmText,
      cancelText: '取消',
      success: async (r) => {
        if (!r.confirm) return
        await this.submitAction(finalReason)
      }
    })
  },

  async submitAction(finalReason) {
    const {
      type,
      sourceType,
      tripId,
      action,
      targetOpenid,
      selectedReason,
      otherReason
    } = this.data
  
    const realType = sourceType || type || 'carpool'
  
    this.setData({ submitting: true })
    wx.showLoading({ title: '正在提交...', mask: true })
  
    const db = wx.cloud.database()
  
    try {
      // 1. 先写入 TripActions
      await db.collection('TripActions').add({
        data: {
          type: realType,
          tripId,
          requestId: tripId,
          action,
  
          targetOpenid: action === 'kickPassenger' ? targetOpenid : '',
          reason: finalReason,
          reasonOption: selectedReason,
          otherReason: selectedReason === '其他' ? String(otherReason || '').trim() : '',
  
          source: action === 'quitTrip' ? 'passenger_reason_page' : 'driver_reason_page',
          createTime: db.serverDate()
        }
      })
  
      // 2. 再执行原来的删除/剔除/退出逻辑
      const callData = {
        type: realType,
        tripId,
        requestId: tripId,
        action,
        reason: finalReason
      }
  
      if (action === 'kickPassenger') {
        callData.targetOpenid = targetOpenid
      }
  
      const result = await callTripManage(callData)
  
      wx.hideLoading()
  
      if (result && (result.ok || result.success)) {
        let toastTitle = '操作成功'
  
        if (action === 'deleteTrip') toastTitle = '已删除路线'
        if (action === 'kickPassenger') toastTitle = '已剔除乘客'
        if (action === 'quitTrip') toastTitle = '已退出路线'
  
        wx.showToast({
          title: toastTitle,
          icon: 'success'
        })
  
        setTimeout(() => {
          if (action === 'deleteTrip') {
            const pages = getCurrentPages()
            if (pages.length >= 3) {
              wx.navigateBack({ delta: 2 })
            } else {
              wx.reLaunch({ url: '/pages/home/home' })
            }
          } else {
            wx.navigateBack()
          }
        }, 500)
      } else {
        wx.showToast({
          title: (result && result.errorMsg) || '操作失败',
          icon: 'none'
        })
      }
    } catch (e) {
      wx.hideLoading()
      console.error('submit trip action reason error:', e)
      wx.showToast({ title: '提交失败', icon: 'none' })
    } finally {
      this.setData({ submitting: false })
    }
  }

})