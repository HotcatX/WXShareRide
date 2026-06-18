// pages/home/driverNewTrip/driverNewTrip.js
Page({
  data: {
    userInfo: null,

    statusBarHeight: 80,
    pageTitle: "新建路线",

    // 地址下拉列表
    departureAddresses: [],
    arrivalAddresses: [],
    loadingDepartureAddrs: true,
    loadingArrivalAddrs: true,

    // 单一出发 / 目的地
    departureAddress: "",
    destinationAddress: "",
    departureDate: "",
    departureTime: "",

    passengerCount: 1,
    passengerCountInput: '1',

    // 车辆信息（在本页可编辑）
    carNumber: "",
    carBrand: "",
    carModel: "",

    // 参考价格 & 备注
    referencePrice: "",
    comment: "",

    // 是否公开 Zelle 信息（默认不公开）
    showZelle: false,

    // ✅ 模板列表
    templates: [],
    loadingTemplates: false,

    submitting: false
  },

  safeSeat(val) {
    const n = parseInt(val, 10)
    if (isNaN(n)) return this.data.passengerCount || 1
    return Math.min(7, Math.max(1, n))
  }, 

  onLoad() {
    const info = wx.getSystemInfoSync()
    this.setData({ statusBarHeight: info.statusBarHeight })

    // 地址列表可对游客开放加载
    this.loadAllAddresses()

    // 仅登录态才加载 userInfo（避免游客误走 getUserInfo）
    this.loadUserInfo()
    this.loadTemplates()
  },

  onShow() {
    // 游客从 login 返回时提示“请先登录”
    const tip = wx.getStorageSync("needLoginToast")
    if (tip) {
      wx.removeStorageSync("needLoginToast")
      wx.showToast({ title: tip, icon: "none", duration: 2000 })
    }

    // 返回页面时刷新一下用户信息（防止在其它页面改了车信息）
    this.loadUserInfo()
    this.loadTemplates()
  },

  onPassengerInput(e) {
    const v = String(e.detail.value || '')
    this.setData({ passengerCountInput: v })
  },
  

  // ===========================
  // 登录态判定（仅用 openid；与你当前 profile.js 一致）
  // ===========================
  isLoggedIn() {
    const openid = wx.getStorageSync("openid") || ""
    return !!openid
  },

  // ===========================
  // 点击“新建出行计划/新建路线”前的登录拦截
  // ===========================
  ensureLoginBeforeCreate() {
    if (this.isLoggedIn()) return true

    wx.setStorageSync("pendingPage", { url: "/pages/home/driverNewTrip/driverNewTrip" })
    wx.setStorageSync("postLoginAction", {
      type: "requireProfile",
      returnUrl: "/pages/home/driverNewTrip/driverNewTrip"
    })

    wx.navigateTo({ url: "/pages/other/login/login" })
    return false
  },

  parseDateTimeSafe(dateStr, timeStr) {
    if (!dateStr || !timeStr) return null

    const d = dateStr.split("-").map(n => parseInt(n, 10))
    const t = timeStr.split(":").map(n => parseInt(n, 10))
    if (d.length !== 3 || t.length !== 2) return null

    const [Y, M, D] = d
    const [hh, mm] = t
    if (!Y || !M || !D || hh < 0 || hh > 23 || mm < 0 || mm > 59) return null

    return new Date(Y, M - 1, D, hh, mm, 0, 0)
  },

  // ===========================
  // 获取 userInfo，并把车信息预填到输入框（保留 getUserInfo）
  // ===========================
  async loadUserInfo() {
    if (!this.isLoggedIn()) {
      this.setData({ userInfo: null })
      return
    }

    try {
      const res = await wx.cloud.callFunction({ name: "getUserInfo" })

      if (!res.result || !res.result.data || res.result.data.length === 0) {
        wx.showToast({
          title: "用户信息缺失，请先完善个人信息",
          icon: "none"
        })
        this.setData({ userInfo: null })
        return
      }

      const user = res.result.data[0]

      this.setData({
        userInfo: user,
        carNumber: user.carNumber || "",
        carBrand: user.carBrand || "",
        carModel: user.carModel || ""
      })
    } catch (e) {
      console.error("获取用户信息失败：", e)
      wx.showToast({ title: "获取用户信息失败", icon: "none" })
      this.setData({ userInfo: null })
    }
  },

  // ===========================
  // 地址列表
  // ===========================
  async loadAllAddresses() {
    this.setData({
      loadingDepartureAddrs: true,
      loadingArrivalAddrs: true
    })

    try {
      const [depRes, arrRes] = await Promise.all([
        this.loadAddressList("Departure"),
        this.loadAddressList("Arrival")
      ])

      this.setData({
        departureAddresses: [...depRes, "其他"],
        arrivalAddresses: [...arrRes, "其他"],
        loadingDepartureAddrs: false,
        loadingArrivalAddrs: false
      })
    } catch (err) {
      console.error("地址加载失败", err)
      this.showError("地址加载失败，请稍后重试")
      this.setData({
        loadingDepartureAddrs: false,
        loadingArrivalAddrs: false
      })
    }
  },

  async loadAddressList(type) {
    try {
      const res = await wx.cloud.callFunction({
        name: "getAddressList",
        data: { type }
      })

      if (res.result && res.result.success) {
        return res.result.addressList
      } else {
        console.error("加载地址失败", res.result)
        wx.showToast({ title: "地址加载失败，请稍后重试", icon: "none" })
        return []
      }
    } catch (e) {
      console.error("加载地址列表失败：", e)
      wx.showToast({ title: "地址加载失败，请稍后重试", icon: "none" })
      return []
    }
  },

  goBack() {
    wx.navigateBack()
  },

  // ===========================
  // ✅ 模板库：读取 CarpoolTemplate（_openid == 当前司机 openid）
  // ===========================
  async loadTemplates() {
    const openid = wx.getStorageSync('openid') || ''
    if (!openid) {
      this.setData({ templates: [], loadingTemplates: false })
      return
    }
  
    this.setData({ loadingTemplates: true })
  
    try {
      const db = wx.cloud.database()
  
      console.log('[loadTemplates] openid=', openid)
  
      const res = await db.collection('CarpoolTemplate')
        .where({ _openid: openid })
        .orderBy('createdAt', 'desc')   // ✅ 用你表里真实存在的字段
        .get()
  
      console.log('[loadTemplates] raw res.data length=', (res.data || []).length)
  
      const templates = (res.data || []).map(t => ({
        ...t,
        departureText: t.departureAddress || '未设置出发地',
        destinationText: t.destinationAddress || '未设置目的地',
        departureTimeText: `${t.weekdayText || ''} ${t.departureTime || ''}`.trim()
      }))
  
      this.setData({ templates })
    } catch (e) {
      console.error('[loadTemplates] failed:', e)
      // 这里建议弹一下，避免“吞错=以为读不到”
      wx.showToast({ title: '模板读取失败', icon: 'none' })
      this.setData({ templates: [] })
    } finally {
      this.setData({ loadingTemplates: false })
    }
  },

  // 把模板整理成列表展示所需字段（尽量兼容不同 schema）
  normalizeTemplateForList(tpl) {
    const dep = tpl.departureAddress || tpl.departAddress || tpl.from || (tpl.departures && tpl.departures[0] && tpl.departures[0].address) || ""
    const dest = tpl.destinationAddress || tpl.destAddress || tpl.to || (tpl.destinations && tpl.destinations[0] && tpl.destinations[0].address) || ""

    const weekdayRaw = tpl.weekday ?? tpl.weekDay ?? tpl.dayOfWeek ?? tpl.week
    const timeRaw = tpl.departureTime || tpl.time || (tpl.departures && tpl.departures[0] && tpl.departures[0].time) || ""

    const weekdayCN = this.weekdayToCN(weekdayRaw)
    const timeText = timeRaw ? String(timeRaw) : "时间未设置"

    return {
      ...tpl,
      departureText: dep || "未设置出发地",
      destinationText: dest || "未设置目的地",
      departureTimeText: weekdayCN ? `${weekdayCN} ${timeText}` : timeText
    }
  },

  // 点击模板：一键复制到当前新建行程
  onTemplateTap(e) {
    const id = e.currentTarget.dataset.id
    const tpl = (this.data.templates || []).find(x => x._id === id)
    if (!tpl) return
  
    const dep = tpl.departureAddress || ''
    const dest = tpl.destinationAddress || ''
  
    const seat = this.safeSeat(tpl.passengerCount) // ✅ 先算 seat
    const referencePrice = tpl.referencePrice || ''
    const comment = tpl.comment || ''
  
    const timeStr = tpl.departureTime ? this.normalizeTimeStr(tpl.departureTime) : ''
    const nextDateStr = this.getNearestDateByWeekdayIndex_Mon0(tpl.weekdayIndex)
  
    this.setData({
      departureAddress: dep,
      destinationAddress: dest,
  
      passengerCount: seat,
      passengerCountInput: String(seat), // ✅ 同步输入框显示
  
      referencePrice,
      comment,
  
      departureDate: nextDateStr || this.data.departureDate,
      departureTime: timeStr || this.data.departureTime,
  
      // ✅ 兼容模板 zelle 存 "yes"/true
      showZelle: tpl.zelle === 'yes' || tpl.zelle === true
    }, () => {
      if (!referencePrice) this.updateReferencePrice()
      wx.showToast({ title: '已应用模板', icon: 'success', duration: 1000 })
    })
  }, 
  
  normalizeTimeStr(t) {
    // 兼容 "9:5" / "09:05" / Date 对象 等
    const s = String(t).trim()
    const m = s.match(/^(\d{1,2}):(\d{1,2})$/)
    if (!m) return s
    const hh = String(Math.min(23, Math.max(0, parseInt(m[1], 10)))).padStart(2, "0")
    const mm = String(Math.min(59, Math.max(0, parseInt(m[2], 10)))).padStart(2, "0")
    return `${hh}:${mm}`
  },

  // weekdayRaw -> 0..6（0=周日, 1=周一...）
  normalizeWeekdayIndex(weekdayRaw) {
    if (weekdayRaw === 0) return 0
    if (!weekdayRaw && weekdayRaw !== 0) return null

    // number: 0-6 or 1-7
    if (typeof weekdayRaw === "number") {
      if (weekdayRaw >= 0 && weekdayRaw <= 6) return weekdayRaw
      if (weekdayRaw >= 1 && weekdayRaw <= 7) return weekdayRaw % 7 // 7->0
    }

    const s = String(weekdayRaw).trim()

    // "周一"..."周日"
    const mapCN = { "周日": 0, "周天": 0, "周一": 1, "周二": 2, "周三": 3, "周四": 4, "周五": 5, "周六": 6 }
    if (mapCN[s] !== undefined) return mapCN[s]

    // "Monday" etc.
    const lower = s.toLowerCase()
    const mapEN = {
      sunday: 0, sun: 0,
      monday: 1, mon: 1,
      tuesday: 2, tue: 2, tues: 2,
      wednesday: 3, wed: 3,
      thursday: 4, thu: 4, thur: 4, thurs: 4,
      friday: 5, fri: 5,
      saturday: 6, sat: 6
    }
    if (mapEN[lower] !== undefined) return mapEN[lower]

    return null
  },

  weekdayToCN(weekdayRaw) {
    const idx = this.normalizeWeekdayIndex(weekdayRaw)
    if (idx === null || idx === undefined) return ""
    return ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][idx]
  },

  // ✅ 距离今天最近的目标周几：今天同周几 => 今天；否则 => 最近的未来那一天（可能是下周）
  getNearestDateByWeekdayIndex_Mon0(idx) {
    if (idx === null || idx === undefined) return ''
  
    // idx: 0=周一..6=周日  → 转成 JS getDay: 1=周一..0=周日
    const targetJsDay = (idx + 1) % 7  // 0->1,1->2,...,5->6,6->0
  
    const now = new Date()
    const todayJsDay = now.getDay() // 0..6
    const add = (targetJsDay - todayJsDay + 7) % 7
  
    const dt = new Date(now.getFullYear(), now.getMonth(), now.getDate() + add)
    const Y = dt.getFullYear()
    const M = String(dt.getMonth() + 1).padStart(2, '0')
    const D = String(dt.getDate()).padStart(2, '0')
    return `${Y}-${M}-${D}`
  },

  // ===========================
  // 地址选择逻辑 + 自动参考价格
  // ===========================
  async onAddressSelect(e) {
    const { type } = e.currentTarget.dataset
    const index = e.detail.value

    const list = type === "departure" ? this.data.departureAddresses : this.data.arrivalAddresses
    const selected = list[index]
    const fieldName = type === "departure" ? "departureAddress" : "destinationAddress"

    if (selected === "其他") {
      const res = await wx.showModal({
        title: "",
        editable: true,
        placeholderText: type === "departure" ? "请输入出发地点" : "请输入目的地"
      })

      if (res.confirm && res.content) {
        this.setData({
          [fieldName]: res.content,
          referencePrice: "价格私议"
        })
      }
    } else {
      this.setData({ [fieldName]: selected }, () => {
        this.updateReferencePrice()
      })
    }
  },

  updateReferencePrice() {
    const dep = this.data.departureAddress
    const dest = this.data.destinationAddress
    if (!dep || !dest) return

    const userInfo = this.data.userInfo || {}
    const customPrice = userInfo.customPrice || {}

    const COL = "哥大"
    const FL_CORE = "Fort Lee 核心区"
    const FL_NONCORE = "Fort Lee 全区域"

    const hasColumbia = dep === COL || dest === COL
    const hasCore = dep === FL_CORE || dest === FL_CORE
    const hasNonCore = dep === FL_NONCORE || dest === FL_NONCORE

    if (hasColumbia && hasNonCore) {
      const val = customPrice.fortLeeNonCore && customPrice.fortLeeNonCore.trim()
        ? customPrice.fortLeeNonCore
        : "13 USD"
      this.setData({ referencePrice: val })
      return
    }

    if (hasColumbia && hasCore) {
      const val = customPrice.fortLeeCore && customPrice.fortLeeCore.trim()
        ? customPrice.fortLeeCore
        : "10 USD"
      this.setData({ referencePrice: val })
      return
    }
  },

  // ===========================
  // 各种输入事件
  // ===========================
  onDateChange(e) { this.setData({ departureDate: e.detail.value }) },
  onTimeChange(e) { this.setData({ departureTime: e.detail.value }) },

  onCarNumberInput(e) { this.setData({ carNumber: e.detail.value }) },
  onCarBrandInput(e) { this.setData({ carBrand: e.detail.value }) },
  onCarModelInput(e) { this.setData({ carModel: e.detail.value }) },
  onReferencePriceInput(e) { this.setData({ referencePrice: e.detail.value }) },

  onCommentInput(e) {
    this.setData({ comment: e.detail.value })
  },

  onZelleCheckboxChange(e) {
    const values = e.detail.value || []
    this.setData({ showZelle: values.includes("showZelle") })
  },

  showError(msg) {
    wx.showToast({ title: msg, icon: "none", duration: 2000 })
  },

  // ===========================
  // 点击“新建出行计划/新建路线”按钮（原逻辑保留）
  // ===========================
  confirmTrip() {
    // ✅ 载客数：仅在提交时校验
    const seat = parseInt(this.data.passengerCountInput, 10)
    if (!seat || isNaN(seat) || seat < 1 || seat > 7) {
      this.showError('载客数量必须为 1-7 的整数')
      return
    }
    this.setData({ passengerCount: seat })

    if (!this.ensureLoginBeforeCreate()) return
    if (this.data.submitting) return

    const {
      userInfo,
      departureAddress,
      destinationAddress,
      departureDate,
      departureTime,
      passengerCount,
      carNumber,
      carBrand,
      carModel,
      referencePrice
    } = this.data

    if (!userInfo) {
      wx.showToast({ title: "请先完善个人信息", icon: "none" })
      wx.setStorageSync("pendingPage", { url: "/pages/home/driverNewTrip/driverNewTrip" })
      wx.navigateTo({ url: "/pages/profile/addInfo/addInfo?from=login" })
      return
    }
    
    // ✅ 新增：微信号校验（只拦截，不跳转）
    if (!userInfo.wechatID || !String(userInfo.wechatID).trim()) {
      wx.showToast({
        title: '请先在个人中心填写微信号',
        icon: 'none',
        duration: 2000
      })
      return
    }
    
    if (!departureAddress || !destinationAddress) return this.showError("请选择出发地和目的地")
    if (departureAddress === destinationAddress) return this.showError("出发地与目的地不能相同")
    if (!departureDate || !departureTime) return this.showError("请完善出发日期和时间")

    const selectedTime = this.parseDateTimeSafe(departureDate, departureTime)
    if (!selectedTime || isNaN(selectedTime.getTime())) return this.showError("时间解析失败，请重新选择日期和时间")

    const now = new Date()
    const diffMin = (selectedTime.getTime() - now.getTime()) / (1000 * 60)

    if (diffMin < 12) return this.showError("发车时间需晚于当前15分钟")
    if (diffMin > 43200) return this.showError("发车时间不能超过30天")

    if (!carNumber || !carBrand || !carModel) return this.showError("请完整填写车牌号、车辆品牌和型号")
    if (!referencePrice || !referencePrice.trim()) return this.showError("请填写参考价格")

    const summary =
      `出发：${departureAddress}  ${departureDate} ${departureTime}\n` +
      `到达：${destinationAddress}\n` +
      `载客数：${passengerCount}\n` +
      `参考价格：${referencePrice}\n` +
      `公开 Zelle 信息：${this.data.showZelle ? "是" : "否"}`

    this.setData({ submitting: true })

    wx.showModal({
      title: "确认新建路线",
      content: summary,
      success: (res) => {
        if (res.confirm) this.submitTrip()
        else this.setData({ submitting: false })
      },
      fail: () => this.setData({ submitting: false })
    })
  },

  // ===========================
  // 真正提交（原逻辑保留）
  // ===========================
  async submitTrip() {
    if (!this.data.submitting) this.setData({ submitting: true })

    try {
      const {
        userInfo,
        departureAddress,
        destinationAddress,
        departureDate,
        departureTime,
        passengerCount,
        comment,
        referencePrice,
        carNumber,
        carBrand,
        carModel,
        showZelle
      } = this.data

      if (!userInfo) {
        this.showError("用户信息缺失，请重新打开页面")
        return
      }

      const departures = [{ address: departureAddress, date: departureDate, time: departureTime }]
      const destinations = [{ address: destinationAddress }]

      const carpoolRes = await wx.cloud.callFunction({
        name: "addCarpoolList",
        data: {
          driverID: userInfo._id,
          departures,
          destinations,
          passengerCount,
          availSeatNum: passengerCount,
          status: "open",
          passengers: [],
          referencePrice,
          comment,
          zelle: showZelle ? "yes" : "no"
        }
      })

      if (!carpoolRes.result || !carpoolRes.result.success || !carpoolRes.result.id) {
        this.showError("路线创建失败，请重试")
        return
      }

      const tripId = carpoolRes.result.id

      const updatePayload = {
        action: "afterCreateTrip",
        tripId,
        carNumber,
        carBrand,
        carModel
      }

      const COL = "哥大"
      const FL_CORE = "Fort Lee 核心区"
      const FL_NONCORE = "Fort Lee 全区域"

      const hasColumbia = departureAddress === COL || destinationAddress === COL
      const hasCore = departureAddress === FL_CORE || destinationAddress === FL_CORE
      const hasNonCore = departureAddress === FL_NONCORE || destinationAddress === FL_NONCORE

      if (hasColumbia && hasNonCore && referencePrice && referencePrice.trim()) {
        updatePayload.customPrice = { fortLeeNonCore: referencePrice }
      } else if (hasColumbia && hasCore && referencePrice && referencePrice.trim()) {
        updatePayload.customPrice = { fortLeeCore: referencePrice }
      }

      const updateRes = await wx.cloud.callFunction({
        name: "updateUserCreateTrip",
        data: updatePayload
      })

      if (!updateRes.result || !updateRes.result.ok) {
        this.showError("路线创建失败，请重试")
        return
      }

      wx.showToast({ title: "路线创建成功", icon: "success", duration: 2000 })
      setTimeout(() => wx.reLaunch({ url: "/pages/home/home" }), 1500)

    } catch (e) {
      console.error("提交路线整体异常：", e)
      this.showError("路线创建失败，请重试")
    } finally {
      this.setData({ submitting: false })
    }
  },

  goHome() {
    wx.reLaunch({ url: "/pages/home/home" })
  }
})
