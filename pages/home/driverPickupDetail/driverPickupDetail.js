// pages/home/driverPickupDetail/driverPickupDetail.js
const LOGIN_PAGE = '/pages/other/login/login'
const DETAIL_REFRESH_INTERVAL = 30 * 1000

function getWeekdayStr(dateStr) {
  if (!dateStr) return ''
  const parts = String(dateStr).split('-')
  if (parts.length !== 3) return ''
  const y = Number(parts[0])
  const m = Number(parts[1])
  const d = Number(parts[2])
  if (!y || !m || !d) return ''
  const dt = new Date(y, m - 1, d)
  const map = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  return map[dt.getDay()] || ''
}

function formatDateNoYear(dateStr) {
  if (!dateStr) return ''
  const parts = String(dateStr).split('-')
  if (parts.length !== 3) return ''
  return `${Number(parts[1])}月${Number(parts[2])}日`
}

function uniq(arr) {
  const set = new Set()
  ;(arr || []).forEach(x => {
    const v = (x || '').trim()
    if (v) set.add(v)
  })
  return Array.from(set)
}

Page({
  data: {
    statusBarHeight: 80,
    pageTitle: '司机接人',

    loading: true,
    loadError: '',
    submitting: false,

    requestId: '',
    request: null,

    departAddress: '',
    destAddress: '',
    formattedDepartTime: '',

    // ✅ 不再展示乘客信息：仍保留字段避免别处引用报错
    passengerList: [],
    defaultAvatarUrl: '/images/default_avatar.png',

    // 状态
    myOpenid: '',
    requestOwnerOpenid: '',
    isOwner: false,

    isAccepted: false,
    acceptedByMe: false,

    joinedAsPassenger: false
  },

  async onLoad(options) {
    const info = wx.getSystemInfoSync()
    this.setData({ statusBarHeight: info.statusBarHeight })

    const id = (options && options.id) || ''
    if (!id) {
      this.setLoadError('缺少路线ID')
      return
    }

    // ✅ 允许游客先浏览：不强制跳登录
    const myOpenid = wx.getStorageSync('openid') || ''
    this.setData({ requestId: id, myOpenid })

    // ✅ 新增：开启分享
    wx.showShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] })

    await this.loadRequestDetail(id)
  },

  onShow() {
    // ✅ 从 login “游客身份查看”返回时的提示
    const tip = wx.getStorageSync('needLoginToast')
    if (tip) {
      wx.removeStorageSync('needLoginToast')
      wx.showToast({ title: tip, icon: 'none', duration: 2000 })
    }

    // ✅ 回到页面时刷新 myOpenid（可能刚登录/刚完善资料回来）
    const myOpenid = wx.getStorageSync('openid') || ''
    this.setData({ myOpenid })

    // ✅ 若已有 requestId，刷新详情（让按钮状态正确）
    const { requestId } = this.data
    if (!requestId || this.data.loading) return
    if (Date.now() - (this._lastDetailLoadedAt || 0) < DETAIL_REFRESH_INTERVAL) return
    this.loadRequestDetail(requestId, { silent: true })
  },

  async onPullDownRefresh() {
    try {
      const { requestId } = this.data
      if (requestId) await this.loadRequestDetail(requestId, { silent: true })
    } finally {
      wx.stopPullDownRefresh()
    }
  },

  goBack() {
    const pages = getCurrentPages()
    if (pages.length > 1) wx.navigateBack()
    else wx.switchTab({ url: '/pages/home/home' })
  },

  setLoadError(message) {
    this.setData({
      loading: false,
      loadError: message || '加载失败',
      request: null,
      departAddress: '',
      destAddress: '',
      formattedDepartTime: '',
      passengerList: [],
      requestOwnerOpenid: '',
      isOwner: false,
      isAccepted: false,
      acceptedByMe: false,
      joinedAsPassenger: false,
      submitting: false
    })
  },

  // =========================
  // ✅ 登录拦截：接单前强制登录 + 强制完善资料（仅本页触发）
  // =========================
  ensureLoginForAccept() {
    const { requestId } = this.data
    const myOpenid = wx.getStorageSync('openid') || ''
    if (myOpenid) return true

    const pendingUrl = `/pages/home/driverPickupDetail/driverPickupDetail?id=${requestId}`
    wx.setStorageSync('pendingPage', { url: pendingUrl })

    // 关键：告诉 login 这是需要完善资料的入口（driverPickupDetail）
    wx.setStorageSync('postLoginAction', {
      type: 'requireProfile',
      from: 'driverPickupDetail',
      returnUrl: pendingUrl
    })

    wx.navigateTo({ url: LOGIN_PAGE })
    return false
  },

  // 读取 CarpoolRequest 详情
  async loadRequestDetail(id, options = {}) {
    const { silent = false } = options
    if (!silent) this.setData({ loading: true, loadError: '' })

    try {
      const res = await wx.cloud.callFunction({
        name: 'getCarpoolRequestDetail',
        data: { id }
      })

      if (!res.result || !res.result.success) {
        const msg = (res.result && (res.result.errorMsg || res.result.msg)) || '加载失败'
        this.setLoadError(msg)
        return
      }

      const request = res.result.data
      if (!request) {
        this.setLoadError('该求车路线不存在或已被删除')
        return
      }

      // 1) 顶部展示字段
      let departAddress = ''
      let destAddress = ''
      let formattedDepartTime = ''

      if (Array.isArray(request.departures) && request.departures.length > 0) {
        const d = request.departures[0]
        departAddress = d.address || ''
        const dateStr = d.date || ''
        const timeStr = (d.time || '').slice(0, 5)

        const weekday = getWeekdayStr(dateStr)
        const dateNoYear = formatDateNoYear(dateStr)

        if (dateNoYear && timeStr) formattedDepartTime = `${dateNoYear} ${weekday} ${timeStr}`
        else if (dateNoYear) formattedDepartTime = `${dateNoYear} ${weekday}`
        else formattedDepartTime = timeStr || ''
      }

      if (Array.isArray(request.destinations) && request.destinations.length > 0) {
        destAddress = request.destinations[0].address || ''
      }

      // 2) owner 与 joined passenger
      const requestOwnerOpenid = request.openid || request._openid || ''
      const myOpenid = this.data.myOpenid || ''

      const joinedArrRaw =
        (Array.isArray(request.passengerID) && request.passengerID) ||
        (Array.isArray(request.passengerIds) && request.passengerIds) ||
        (Array.isArray(request.passengers) && request.passengers) ||
        []
      const joinedArr = uniq(joinedArrRaw)

      const isOwner = !!(requestOwnerOpenid && myOpenid && requestOwnerOpenid === myOpenid)
      const joinedAsPassenger = !!(myOpenid && joinedArr.includes(myOpenid))

      // 3) 接单状态
      const driverOpenid = request.driverOpenid || request.driverID || ''
      const isAccepted = !!driverOpenid || (request.status && request.status !== 'open')
      const acceptedByMe = !!(driverOpenid && myOpenid && driverOpenid === myOpenid)

      // ✅ 不再拉取/展示乘客信息（接单成功也不展示）
      const passengerList = []

      this.setData({
        request,
        departAddress,
        destAddress,
        formattedDepartTime,

        requestOwnerOpenid,
        isOwner,

        joinedAsPassenger,
        isAccepted,
        acceptedByMe,

        passengerList,
        loadError: '',
        loading: false
      })
      this._lastDetailLoadedAt = Date.now()
    } catch (err) {
      console.error('loadRequestDetail error:', err)
      this.setLoadError('网络异常，请稍后重试')
    }
  },

  // 司机成为该路线司机
  async acceptAsDriver() {
    const {
      requestId,
      request,
      isAccepted,
      acceptedByMe,
      submitting,
      isOwner,
      joinedAsPassenger
    } = this.data

    if (!requestId) return
    if (submitting) return

    // ✅ 先做登录 + 完善资料拦截（游客点按钮会去 login）
    if (!this.ensureLoginForAccept()) return

    // 刷新 myOpenid（确保后续判断使用最新登录态）
    const myOpenid = wx.getStorageSync('openid') || ''
    this.setData({ myOpenid })

    // 规则1：自己不能接自己
    if (isOwner) {
      wx.showToast({ title: '不能成为自己求车的司机', icon: 'none' })
      return
    }

    // 规则2：如果已作为乘客加入，则不能接单（双保险）
    const joinedArrRaw =
      (request && Array.isArray(request.passengerID) && request.passengerID) ||
      (request && Array.isArray(request.passengerIds) && request.passengerIds) ||
      (request && Array.isArray(request.passengers) && request.passengers) ||
      []
    const joinedArr = uniq(joinedArrRaw)
    const alreadyPassenger = joinedAsPassenger || (myOpenid && joinedArr.includes(myOpenid))

    if (alreadyPassenger) {
      wx.showToast({ title: '你已作为乘客加入该路线，无法再接单', icon: 'none' })
      return
    }

    // 已被接单
    if (isAccepted) {
      if (acceptedByMe) wx.showToast({ title: '你已接单', icon: 'none' })
      else wx.showToast({ title: '已被其他司机接单', icon: 'none' })
      return
    }

    this.setData({ submitting: true })

    try {
      const ret = await wx.cloud.callFunction({
        name: 'acceptCarpoolRequest',
        data: { requestId }
      })


      if (ret.result && ret.result.success) {
        wx.showToast({ title: '接单成功', icon: 'success', duration: 1200 })
        setTimeout(() => {
          wx.switchTab({ url: '/pages/home/home' })
        }, 1200)
        return
      }      

      // ✅ 接单成功：不展示乘客信息，直接回首页
      wx.showToast({ title: '接单成功', icon: 'success', duration: 1200 })
      setTimeout(() => {
        wx.switchTab({ url: '/pages/home/home' })
      }, 1200)

    } catch (e) {
      console.error('acceptAsDriver error:', e)
      wx.showToast({ title: '接单失败', icon: 'none' })
    } finally {
      this.setData({ submitting: false })
    }
  },

  onShareAppMessage() {
    const { requestId, departAddress, destAddress, formattedDepartTime } = this.data
    const title = `${departAddress} → ${destAddress} ${formattedDepartTime}`.trim().slice(0, 30)
    return {
      title: title ? `${title}｜寻找顺路司机` : '寻找顺路司机',
      path: `/pages/home/driverPickupDetail/driverPickupDetail?id=${requestId}`
    }
  },
  
  onShareTimeline() {
    const { requestId, departAddress, destAddress, formattedDepartTime } = this.data
    const title = `${departAddress} → ${destAddress} ${formattedDepartTime}`.trim().slice(0, 30)
    return {
      title: title ? `${title}｜寻找顺路司机` : '寻找顺路司机',
      query: `id=${requestId}`
    }
  }
  
})
