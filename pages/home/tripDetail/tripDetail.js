// pages/home/tripDetail/tripDetail.js
const LOGIN_PAGE = '/pages/other/login/login'

// ===== 工具函数：把 "2025-12-01" 转成 "周三" =====
function getWeekdayStr(dateStr) {
  if (!dateStr) return ''
  const parts = dateStr.split('-')
  if (parts.length !== 3) return ''
  const y = Number(parts[0])
  const m = Number(parts[1])
  const d = Number(parts[2])
  if (!y || !m || !d) return ''
  const dt = new Date(y, m - 1, d)
  const day = dt.getDay()
  const map = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  return map[day] || ''
}

function formatDateNoYear(dateStr) {
  if (!dateStr) return ''
  const parts = String(dateStr).split('-')
  if (parts.length !== 3) return ''
  const m = parts[1]
  const d = parts[2]
  return `${Number(m)}月${Number(d)}日`
}

// ===== 判断地址是否命中 Fort Lee 核心区关键词 =====
function containsFortLeeCore(addr) {
  if (!addr) return false
  const s = String(addr).toLowerCase()
  const keywords = [
    'fiat house',
    'modern',
    '2050',
    'hudson lights',
    'fort lee 核心区',
    'fort lee核心区',
    'fort lee core'
  ]
  return keywords.some(k => s.includes(k))
}

Page({
  data: {
    trip: null,
    loading: true,
    hasJoined: false,
    isOwner: false,

    statusBarHeight: 80,
    pageTitle: "路线详情",

    toastVisible: false,
    toastText: '',
    toastType: 'success',
    toastIcon: '',

    submitting: false,

    driverInfo: null,

    departAddress: '',
    destAddress: '',
    formattedDepartTime: '',
    carBrandModel: '',

    tripId: '',

    showFortLeeCoreTip: false,

    pickupAddress: "",
    dropoffAddress: "",
  
    pickupSpotList: [],
    dropoffSpotList: [],
  
    showPickupOptions: false,
    showDropoffOptions: false,
  },

  async loadUserSpots() {
    const openid = wx.getStorageSync("openid")
    if (!openid) return
  
    const db = wx.cloud.database()
    const res = await db.collection("userInfo").where({ _openid: openid }).limit(1).get()
    const info = res.data[0] || {}
  
    this.setData({
      pickupSpotList: info.pickupSpot || [],
      dropoffSpotList: info.dropoffSpot || []
    })
  },
  

  onPullDownRefresh: async function () {
    const { tripId, trip } = this.data
    const id = tripId || (trip && trip._id)
    if (!id) {
      wx.stopPullDownRefresh()
      return
    }
    try {
      await this.loadTripDetail(id, { silent: true })
    } catch (e) {
      console.error('onPullDownRefresh error', e)
    } finally {
      wx.stopPullDownRefresh()
    }
  },

  onShareAppMessage() {
    const { tripId, trip, departAddress, destAddress, formattedDepartTime } = this.data
    const realId = tripId || (trip && trip._id) || ''
    const title = `${departAddress} → ${destAddress} ${formattedDepartTime}`.trim().slice(0, 30)
    return {
      title: title ? `${title}｜寻找顺路乘客` : '寻找顺路乘客',
      path: `/pages/home/tripDetail/tripDetail?id=${realId}`,
    }
  },

  onShareTimeline() {
    const { tripId, trip, departAddress, destAddress, formattedDepartTime } = this.data
    const realId = tripId || (trip && trip._id) || ''
    const title = `${departAddress} → ${destAddress} ${formattedDepartTime}`.trim().slice(0, 30)
    return {
      title: title ? `${title}｜寻找顺路乘客` : '寻找顺路乘客',
      query: `id=${realId}`
    }
  },

  async onLoad(options) {
    const info = wx.getSystemInfoSync()
    this.setData({ statusBarHeight: info.statusBarHeight })

    const tripId = (options && (options.id || options.tripId)) || ''
    if (!tripId) {
      wx.showToast({ title: '缺少路线ID', icon: 'none' })
      this.setData({ loading: false })
      return
    }

    wx.showShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] })

    // ✅ 允许游客浏览：不再 onLoad 强制登录
    this.setData({ tripId })
    await this.loadTripDetail(tripId)

    this.loadUserSpots()

  },


  onShow() {
    this.loadUserSpots()

    // ✅ 从 login 选“游客身份查看”回来的提示
    const tip = wx.getStorageSync('needLoginToast')
    if (tip) {
      wx.removeStorageSync('needLoginToast')
      wx.showToast({ title: tip, icon: 'none', duration: 2000 })
    }

    // ✅ 登录/完善资料回来后，静默刷新一下按钮状态（hasJoined/isOwner）
    const { tripId } = this.data
    if (tripId) this.loadTripDetail(tripId, { silent: true })
  },

  onPickupFocus() {
    this.setData({ showPickupOptions: true })
  },
  onDropoffFocus() {
    this.setData({ showDropoffOptions: true })
  },
  
  onPickupInput(e) {
    this.setData({
      pickupAddress: e.detail.value,
      showPickupOptions: false
    })
  },
  
  onDropoffInput(e) {
    this.setData({
      dropoffAddress: e.detail.value,
      showDropoffOptions: false
    })
  },
  
  onPickupOptionTap(e) {
    this.setData({
      pickupAddress: e.currentTarget.dataset.value,
      showPickupOptions: false
    })
  },
  
  onDropoffOptionTap(e) {
    this.setData({
      dropoffAddress: e.currentTarget.dataset.value,
      showDropoffOptions: false
    })
  },

  onPickupTagSelect(e) {
    const v = String(e.currentTarget.dataset.value || '').trim()
    this.setData({
      pickupAddress: v,
      showPickupOptions: false
    })
  },
  
  onDropoffTagSelect(e) {
    const v = String(e.currentTarget.dataset.value || '').trim()
    this.setData({
      dropoffAddress: v,
      showDropoffOptions: false
    })
  },  
  

  goBack() {
    const pages = getCurrentPages()
    if (pages.length > 1) wx.navigateBack()
    else wx.switchTab({ url: '/pages/home/home' })
  },

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
    }, 2000)
  },

  onUnload() {
    if (this._toastTimer) clearTimeout(this._toastTimer)
  },

  // =========================
  // ✅ 登录拦截：加入路线前必须登录 + 必要时完善资料
  // =========================
  ensureLoginBeforeJoin() {
    const openid = wx.getStorageSync('openid') || ''
    if (openid) return true

    const { tripId, trip } = this.data
    const id = tripId || (trip && trip._id) || ''
    const pendingUrl = `/pages/home/tripDetail/tripDetail?id=${id}`

    wx.setStorageSync('pendingPage', { url: pendingUrl })
    wx.setStorageSync('postLoginAction', {
      type: 'requireProfile',
      from: 'tripDetail',
      returnUrl: pendingUrl
    })

    wx.navigateTo({ url: LOGIN_PAGE })
    return false
  },

  // =========================
  // loadTripDetail
  // =========================
  async loadTripDetail(id, options = {}) {
    const { silent = false } = options
    if (!silent) wx.showLoading({ title: '加载中...' })

    try {
      const res = await wx.cloud.callFunction({
        name: 'getCarpoolDetail',
        data: { id }
      })

      if (!res.result || !res.result.success) {
        if (!silent) wx.hideLoading()
        this.showToastBar('加载失败', 'error')
        this.setData({ loading: false })
        return
      }

      const trip = Array.isArray(res.result.data)
        ? res.result.data[0]
        : res.result.data

      if (!trip) {
        if (!silent) wx.hideLoading()
        this.showToastBar('未找到该路线', 'warn')
        this.setData({ loading: false })
        return
      }

      const myOpenid = wx.getStorageSync('openid') || ''
      let hasJoined = false
      let isOwner = false

      if (myOpenid) {
        if (trip._openid === myOpenid) isOwner = true
        if (Array.isArray(trip.passengers)) {
          hasJoined = trip.passengers.some(p => p && p._openid === myOpenid)
        }
      }

      let driverInfo = null
      if (trip._openid) {
        try {
          const userRes = await wx.cloud.callFunction({
            name: 'getUserInfoByOpenids',
            data: { openids: [trip._openid] }
          })
          if (userRes.result && userRes.result.ok) {
            const list = userRes.result.data || []
            if (list.length > 0) driverInfo = list[0]
          }
        } catch (e) {
          console.error('tripDetail 查询司机信息失败：', e)
        }
      }

      let departAddress = ''
      let destAddress = ''
      let formattedDepartTime = ''

      let carBrandModel = ''
      if (driverInfo) {
        const parts = []
        if (driverInfo.carBrand) parts.push(driverInfo.carBrand)
        if (driverInfo.carModel) parts.push(driverInfo.carModel)
        carBrandModel = parts.join(' ')
      }

      if (Array.isArray(trip.departures) && trip.departures.length > 0) {
        const d = trip.departures[0]
        departAddress = d.address || ''
        const dateStr = d.date || ''
        const timeStr = d.time || ''
        const weekday = getWeekdayStr(dateStr)
        const dateNoYear = formatDateNoYear(dateStr)
        if (dateNoYear && timeStr) formattedDepartTime = `${dateNoYear} ${weekday} ${timeStr}`
        else if (dateNoYear) formattedDepartTime = `${dateNoYear} ${weekday}`
        else formattedDepartTime = timeStr || ''
      }

      if (Array.isArray(trip.destinations) && trip.destinations.length > 0) {
        destAddress = trip.destinations[0].address || ''
      }

      const showFortLeeCoreTip = containsFortLeeCore(departAddress) || containsFortLeeCore(destAddress)

      this.setData({
        trip,
        hasJoined,
        isOwner,
        driverInfo,
        departAddress,
        destAddress,
        formattedDepartTime,
        carBrandModel,
        showFortLeeCoreTip,
        loading: false
      })

      if (!silent) wx.hideLoading()
    } catch (err) {
      if (!silent) wx.hideLoading()
      this.showToastBar('网络异常', 'error')
      console.error('请求错误:', err)
      this.setData({ loading: false })
    }
  },

  // =========================
  // 一键加入出行路线（加入必填上下车点 + 写入乘客记录）
  // =========================
  async joinCarpool() {
    const { trip, hasJoined, submitting, isOwner, tripId, pickupAddress, dropoffAddress } = this.data

    // const p = String(this.data.pickupAddress || '').trim()
    // const d = String(this.data.dropoffAddress || '').trim()
    // if (!p || !d) {
    //   wx.showToast({ title: '请先填写上车点和下车点', icon: 'none' })
    //   return
    // }

    if (isOwner) {
      wx.showToast({ title: '无法加入自己发布的路线', icon: 'none' })
      return
    }
    if (hasJoined) {
      wx.showToast({ title: '您已成功加入路线', icon: 'none' })
      return
    }
    if (submitting) return

    // ✅ 0) 必填校验：必须填上车点 + 下车点
    const p = String(pickupAddress || '').trim()
    const d = String(dropoffAddress || '').trim()
    if (!p || !d) {
      wx.showToast({ title: '请先填写上车点和下车点', icon: 'none' })
      return
    }

    // ✅ 1) 未登录先去 login，并要求必要时去 addInfo
    if (!this.ensureLoginBeforeJoin()) return

    this.setData({ submitting: true })
    wx.showLoading({ title: '正在加入...' })

    try {
      const openid = wx.getStorageSync('openid') || ''
      if (!openid) {
        wx.hideLoading()
        wx.showToast({ title: '请先登录', icon: 'none' })
        return
      }

      // 从云端读取当前用户资料（用于写 passengers）
      const userRes = await wx.cloud.callFunction({ name: 'getUserInfo' })
      const list = (userRes.result && userRes.result.data) || []

      // 已登录但资料不存在：引导 addInfo
      if (!list.length) {
        wx.hideLoading()
        const id = tripId || (trip && trip._id) || ''
        const pendingUrl = `/pages/home/tripDetail/tripDetail?id=${id}`
        wx.setStorageSync('pendingPage', { url: pendingUrl })
        wx.showToast({ title: '请先完善个人信息', icon: 'none' })
        wx.navigateTo({ url: '/pages/profile/addInfo/addInfo?from=login' })
        return
      }

      const userInfo = list[0]
      userInfo._openid = openid
      
      // ✅ 微信号校验（只拦截，不跳转）
      if (!userInfo.wechatID || !String(userInfo.wechatID).trim()) {
        wx.hideLoading()
        wx.showToast({
          title: '请先在个人中心填写微信号',
          icon: 'none'
        })
        this.setData({ submitting: false })
        return
      }
      
      // ✅ 继续原有逻辑
      userInfo.pickupAddress = p
      userInfo.dropoffAddress = d      

      // ✅ 2) 把乘客的上车点/下车点附加到本次加入的乘客记录里
      //     （云函数 addCarpoolDetail 需要把这两个字段写入 passengers[] 的那一条记录）
      userInfo.pickupAddress = p
      userInfo.dropoffAddress = d

      // ✅ 3) 更新 Carpool 乘客列表（由云函数写入）
      const carpoolRes = await wx.cloud.callFunction({
        name: 'addCarpoolDetail',
        data: {
          tripId: trip._id,
          passengerInfo: {
            ...userInfo,
            pickupAddress: this.data.pickupAddress,
            dropoffAddress: this.data.dropoffAddress
          }
        }
      })      

      const cResult = carpoolRes.result || {}
      if (!cResult.success) {
        wx.hideLoading()
        wx.showToast({ title: cResult.msg || '加入路线失败', icon: 'none' })
        return
      }

      // ② 写入 userInfo.tripPassenger
      const userTripRes = await wx.cloud.callFunction({
        name: 'updateUserJoinTrip',
        data: { action: 'afterJoinTripPassenger', tripId: trip._id }
      })

      wx.hideLoading()
      const r = userTripRes.result || {}
      const ok = r.ok === true || r.success === true || r.code === 0
      if (!ok) {
        wx.showToast({ title: r.errorMsg || '加入失败，请重试', icon: 'none', duration: 2000 })
        return
      }

      // 刷新 Carpool 状态（失败忽略）
      try {
        await wx.cloud.callFunction({ name: 'updateCarpoolStatus' })
      } catch (e) {
        console.warn('updateCarpoolStatus failed:', e)
      }

      wx.showToast({ title: '加入出行计划成功', icon: 'success', duration: 2000 })
      this.setData({ hasJoined: true, showPickupOptions: false, showDropoffOptions: false })

      await this.loadTripDetail(trip._id, { silent: true })

      const pages = getCurrentPages()
      const prevPage = pages[pages.length - 2]
      if (prevPage && typeof prevPage.loadCarpoolList === 'function') {
        prevPage.loadCarpoolList()
      }
    } catch (err) {
      wx.hideLoading()
      console.error('joinCarpool error:', err)
      wx.showToast({ title: '请求失败，请稍后重试', icon: 'none' })
    } finally {
      this.setData({ submitting: false })
    }
  },

  copyWeChat() {
    const driverInfo = this.data.driverInfo || {}
    const wechat = driverInfo.wechatID
    if (!wechat) {
      wx.showToast({ title: '司机未填写微信号', icon: 'none' })
      return
    }
    wx.setClipboardData({
      data: wechat,
      success: () => wx.showToast({ title: '已复制微信号', icon: 'success', duration: 1500 })
    })
  },

  copyPhone() {
    const driverInfo = this.data.driverInfo || {}
    const phone = driverInfo.phone
    if (!phone) {
      wx.showToast({ title: '司机未填写手机号', icon: 'none' })
      return
    }
    wx.setClipboardData({
      data: phone,
      success: () => wx.showToast({ title: '已复制手机号', icon: 'success', duration: 1500 })
    })
  },

  copyZelle() {
    const driverInfo = this.data.driverInfo || {}
    const name = driverInfo.zelleName
    const acc = driverInfo.zelleAccount
    if (!name || !acc) {
      wx.showToast({ title: '司机未完整填写 Zelle 信息', icon: 'none' })
      return
    }
    wx.setClipboardData({
      data: `${name} ${acc}`,
      success: () => wx.showToast({ title: '已复制 Zelle 信息', icon: 'success', duration: 1500 })
    })
  }
})
