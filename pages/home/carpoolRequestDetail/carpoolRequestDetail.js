// pages/home/carpoolRequestDetail/carpoolRequestDetail.js
const LOGIN_PAGE = '/pages/other/login/login'
const DETAIL_REFRESH_INTERVAL = 30 * 1000

// 乘客上限（CarpoolRequest 固定 4）
const MAX_PASSENGERS = 4

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

// 兼容 passengerID 可能为 string / array / 空
function normalizepassengerID(raw) {
  if (Array.isArray(raw)) return raw.filter(Boolean).map(x => String(x))
  if (typeof raw === 'string' && raw.trim()) return [raw.trim()]
  if (raw) return [String(raw)]
  return []
}

// 去重并过滤空值
function uniq(arr) {
  const s = new Set()
  ;(arr || []).forEach(x => {
    const v = String(x || '').trim()
    if (v) s.add(v)
  })
  return Array.from(s)
}

Page({
  data: {
    statusBarHeight: 80,
    pageTitle: '路线详情',

    loading: true,
    submitting: false,

    tripId: '',
    trip: null,

    departAddress: '',
    destAddress: '',
    formattedDepartTime: '',

    seatLeft: 0,

    // 用户信息（可能为空：游客）
    myOpenid: '',
    ownerOpenid: '',
    driverOpenid: '',

    isOwner: false,
    joinedByMe: false,
    isFull: false,
    isClosed: false,

    // ✅ 新增：我是否为该路线司机
    isDriver: false,

    // ✅ 不再展示司机/其他乘客信息（保留字段避免 WXML/其他引用报错）
    driverInfo: null,
    passengerList: [],
    defaultAvatarUrl: '/images/default_avatar.png'
  },

  async onLoad(options) {
    const info = wx.getSystemInfoSync()
    this.setData({ statusBarHeight: info.statusBarHeight })

    const id = (options && options.id) || ''
    if (!id) {
      wx.showToast({ title: '缺少记录ID', icon: 'none' })
      this.setData({ loading: false })
      return
    }

    // ✅ 允许游客浏览：不再 onLoad 强制跳 login
    const myOpenid = wx.getStorageSync('openid') || ''
    this.setData({ tripId: id, myOpenid })
    wx.showShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] })
    await this.loadTripDetail(id)
  },

  onShow() {
    // ✅ 从 login “游客身份查看”返回时的提示
    const tip = wx.getStorageSync('needLoginToast')
    if (tip) {
      wx.removeStorageSync('needLoginToast')
      wx.showToast({ title: tip, icon: 'none', duration: 2000 })
    }

    // ✅ 登录/完善资料回来后刷新状态（按钮会变化）
    const myOpenid = wx.getStorageSync('openid') || ''
    this.setData({ myOpenid })

    const { tripId } = this.data
    if (!tripId || this.data.loading) return
    if (Date.now() - (this._lastDetailLoadedAt || 0) < DETAIL_REFRESH_INTERVAL) return
    this.loadTripDetail(tripId, { silent: true })
  },

  async onPullDownRefresh() {
    try {
      const { tripId } = this.data
      if (tripId) await this.loadTripDetail(tripId, { silent: true })
    } finally {
      wx.stopPullDownRefresh()
    }
  },

  goBack() {
    const pages = getCurrentPages()
    if (pages.length > 1) wx.navigateBack()
    else wx.switchTab({ url: '/pages/home/home' })
  },

  // 系统默认 toast
  showToast(text, icon = 'none', duration = 1800) {
    wx.showToast({ title: text, icon, duration })
  },

  // =========================
  // ✅ 登录+完善资料拦截（仅在“加入”动作触发）
  // =========================
  ensureLoginBeforeJoin() {
    const openid = wx.getStorageSync('openid') || ''
    if (openid) return true

    const { tripId } = this.data
    const pendingUrl = `/pages/home/carpoolRequestDetail/carpoolRequestDetail?id=${tripId}`

    wx.setStorageSync('pendingPage', { url: pendingUrl })
    wx.setStorageSync('postLoginAction', {
      type: 'requireProfile',
      from: 'carpoolRequestDetail',
      returnUrl: pendingUrl
    })

    wx.navigateTo({ url: LOGIN_PAGE })
    return false
  },

  /**
   * 拉取 CarpoolRequest 详情（允许游客）：
   * - 计算顶部展示字段 + seatLeft + status
   * - 若已登录：额外计算 isOwner / joinedByMe / isDriver
   * - ✅ 不再读取司机/其他乘客信息
   */
  async loadTripDetail(id, options = {}) {
    const { silent = false } = options
    if (!silent) this.setData({ loading: true })

    try {
      const res = await wx.cloud.callFunction({
        name: 'getCarpoolRequestDetail',
        data: { id }
      })

      if (!res.result || !res.result.success) {
        this.showToast('加载失败', 'none')
        this.setData({ loading: false })
        return
      }

      const trip = res.result.data
      if (!trip) {
        this.showToast('未找到该路线', 'none')
        this.setData({ loading: false })
        return
      }

      // 1) 顶部展示字段
      let departAddress = ''
      let destAddress = ''
      let formattedDepartTime = ''

      if (Array.isArray(trip.departures) && trip.departures.length > 0) {
        const d = trip.departures[0]
        departAddress = d.address || ''
        const dateStr = d.date || ''
        const timeStr = (d.time || '').slice(0, 5)

        const weekday = getWeekdayStr(dateStr)
        const dateNoYear = formatDateNoYear(dateStr)

        if (dateNoYear && timeStr) formattedDepartTime = `${dateNoYear} ${weekday} ${timeStr}`
        else if (dateNoYear) formattedDepartTime = `${dateNoYear} ${weekday}`
        else formattedDepartTime = timeStr || ''
      }

      if (Array.isArray(trip.destinations) && trip.destinations.length > 0) {
        destAddress = trip.destinations[0].address || ''
      }

      // 2) owner / driver openid
      const ownerOpenid = trip.openid || trip._openid || ''
      const driverOpenid = trip.driverOpenid || trip.driverID || ''

      // 3) passengerID
      const passengerID = normalizepassengerID(trip.passengerID)

      // 4) 人数与余位
      const passengerCount =
        Number.isFinite(Number(trip.passengerCount))
          ? Number(trip.passengerCount)
          : passengerID.length

      const seatLeft = Math.max(0, MAX_PASSENGERS - passengerCount)
      const isFull = seatLeft <= 0

      // 5) 状态：只要不是 open 就视为不可加入
      const st = String(trip.status || 'open')
      const isClosed = (st !== 'open') || (st === 'close' || st === 'closed' || st === 'past')

      // 6) 已登录才计算“我是谁”
      const myOpenid = wx.getStorageSync('openid') || ''
      const isOwner = !!(ownerOpenid && myOpenid && ownerOpenid === myOpenid)
      const isDriver = !!(driverOpenid && myOpenid && driverOpenid === myOpenid)
      const joinedByMe = !!(myOpenid && passengerID.includes(myOpenid))

      this.setData({
        trip,
        departAddress,
        destAddress,
        formattedDepartTime,
        seatLeft,

        myOpenid,
        ownerOpenid,
        driverOpenid,

        isOwner,
        isDriver,
        joinedByMe,
        isFull,
        isClosed,

        // ✅ 不再展示信息
        driverInfo: null,
        passengerList: [],

        loading: false
      })
      this._lastDetailLoadedAt = Date.now()
    } catch (err) {
      console.error('loadTripDetail error:', err)
      this.showToast('网络异常', 'none')
      this.setData({ loading: false })
    }
  },

  // =========================
  // ✅ 乘客加入 CarpoolRequest
  // 变更：
  // 1) 未登录 -> login + 必要时 addInfo
  // 2) 不显示司机/其他乘客，成功后直接跳首页
  // =========================
  async joinAsPassenger() {
    const { tripId, submitting, isOwner, joinedByMe, isFull, isClosed, isDriver, trip } = this.data
    if (!tripId) return
    if (submitting) return

    // ✅ 先做登录 + 完善资料拦截
    if (!this.ensureLoginBeforeJoin()) return

    // 刷新一次 openid（刚登录回来）
    const myOpenid = wx.getStorageSync('openid') || ''
    this.setData({ myOpenid })

    // 防误操作
    if (isOwner) {
      this.showToast('不能加入自己发布的求车', 'none')
      return
    }
    if (isDriver) {
      this.showToast('你已是该路线司机，无法作为乘客加入', 'none')
      return
    }
    if (joinedByMe) {
      this.showToast('你已加入该求车', 'none')
      return
    }

    const st = String((trip && trip.status) || 'open')
    if (st !== 'open') {
      this.showToast(`当前状态不可加入：${st}`, 'none')
      return
    }
    if (isClosed) {
      this.showToast('该求车已结束', 'none')
      return
    }
    if (isFull) {
      this.showToast('该求车已满员', 'none')
      return
    }

    this.setData({ submitting: true })

    try {
      const ret = await wx.cloud.callFunction({
        name: 'joinCarpoolRequest',
        data: { requestId: tripId }
      })

      if (ret.result && ret.result.success) {
        // ✅ 不展示任何成员信息，直接回首页
        this.showToast('加入成功', 'success', 1200)
        setTimeout(() => {
          wx.switchTab({ url: '/pages/home/home' })
        }, 1200)
        return
      }

      const msg = (ret.result && ret.result.errorMsg) ? ret.result.errorMsg : '加入失败'
      this.showToast(msg, 'none')
    } catch (e) {
      console.error('joinCarpoolRequest error:', e)
      this.showToast('加入失败', 'none')
    } finally {
      this.setData({ submitting: false })
    }
  },

  onShareAppMessage() {
    const { tripId, departAddress, destAddress, formattedDepartTime } = this.data
    const title = `${departAddress} → ${destAddress} ${formattedDepartTime}`.trim().slice(0, 30)
    return {
      title: title ? `${title}｜寻找顺路乘客` : '寻找顺路乘客',
      // ✅ 导向本页面
      path: `/pages/home/carpoolRequestDetail/carpoolRequestDetail?id=${tripId}`
    }
  },
  
  onShareTimeline() {
    const { tripId, departAddress, destAddress, formattedDepartTime } = this.data
    const title = `${departAddress} → ${destAddress} ${formattedDepartTime}`.trim().slice(0, 30)
    return {
      title: title ? `${title}｜寻找顺路乘客` : '寻找顺路乘客',
      // ✅ 朋友圈用 query
      query: `id=${tripId}`
    }
  }
  
  
})
