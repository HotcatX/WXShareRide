// pages/home/passengerNewTrip/passengerNewTrip.js
Page({
  data: {
    statusBarHeight: 80,
    pageTitle: "乘客求车",

    // 地址列表
    departureAddresses: [],
    arrivalAddresses: [],
    loadingDepartureAddrs: true,
    loadingArrivalAddrs: true,

    // 已选字段
    departureAddress: "",
    destinationAddress: "",
    departureDate: "",
    departureTime: "",
    passengerCount: 1,

    // ✅ 价格展示（不可修改）
    referencePrice: "",          // 显示用字符串（可能是数字字符串，也可能是“请参考打车价格”）
    priceLocked: true,           // 永远锁定不可编辑（按你的需求：价格不可修改）

    userInfo: null,
    submitting: false,
    acceptCarpool: false
  },

  onLoad() {
    const info = wx.getSystemInfoSync()
    this.setData({ statusBarHeight: info.statusBarHeight })

    // ✅ 地址可对游客开放
    this.loadAllAddresses()

    // ✅ 仅登录态才加载 userInfo（避免游客进来就提示“完善信息”）
    this.loadUserInfo()
  },

  onShow() {
    // ✅ 从 login “游客身份查看”返回时的提示
    const tip = wx.getStorageSync("needLoginToast")
    if (tip) {
      wx.removeStorageSync("needLoginToast")
      wx.showToast({ title: tip, icon: "none", duration: 2000 })
    }

    this.loadUserInfo()
  },

  // =========================
  // 登录态判定：与 profile.js 一致，仅看 storage.openid
  // =========================
  isLoggedIn() {
    const openid = wx.getStorageSync("openid") || ""
    return !!openid
  },

  // ✅ 发起求车前：强制登录 + 强制完善资料（仅本页触发）
  ensureLoginBeforeCreate() {
    if (this.isLoggedIn()) return true

    const pendingUrl = "/pages/home/passengerNewTrip/passengerNewTrip"
    wx.setStorageSync("pendingPage", { url: pendingUrl })

    wx.setStorageSync("postLoginAction", {
      type: "requireProfile",
      from: "passengerNewTrip",
      returnUrl: pendingUrl
    })

    wx.navigateTo({ url: "/pages/other/login/login" })
    return false
  },

  goBack() {
    wx.navigateBack()
  },

  showError(msg) {
    wx.showToast({ title: msg, icon: "none", duration: 2000 })
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
  onCarpoolChange(e) {
    const checked = (e.detail.value || []).includes("1")
    this.setData({ acceptCarpool: checked })
  },
  
  // -------------------------
  // 读取 userInfo（仅登录态调用）
  // -------------------------
  async loadUserInfo() {
    if (!this.isLoggedIn()) {
      this.setData({ userInfo: null })
      return
    }

    try {
      const res = await wx.cloud.callFunction({ name: "getUserInfo" })
      const list = res?.result?.data || []
      if (!list.length) {
        this.setData({ userInfo: null })
        return
      }
      this.setData({ userInfo: list[0] })
    } catch (e) {
      console.error("loadUserInfo error:", e)
      this.setData({ userInfo: null })
      wx.showToast({ title: "获取用户信息失败", icon: "none" })
    }
  },

  // -------------------------
  // 地址列表
  // -------------------------
  async loadAllAddresses() {
    this.setData({ loadingDepartureAddrs: true, loadingArrivalAddrs: true })

    try {
      const [dep, arr] = await Promise.all([
        this.loadAddressList("Departure_Request"),
        this.loadAddressList("Arrival_Request")
      ])

      this.setData({
        departureAddresses: [...dep, "其他"],
        arrivalAddresses: [...arr, "其他"],
        loadingDepartureAddrs: false,
        loadingArrivalAddrs: false
      })
    } catch (e) {
      console.error("loadAllAddresses error:", e)
      this.setData({ loadingDepartureAddrs: false, loadingArrivalAddrs: false })
      this.showError("地址加载失败，请稍后重试")
    }
  },

  async loadAddressList(type) {
    const res = await wx.cloud.callFunction({
      name: "getAddressList",
      data: { type }
    })
    if (res?.result?.success) return res.result.addressList || []
    return []
  },

  // -------------------------
  // ✅ 地址选择 + 自动匹配 Request_Price 价格（不可修改）
  // -------------------------
  async onAddressSelect(e) {
    const { type } = e.currentTarget.dataset
    const idx = Number(e.detail.value)

    const list = type === "departure" ? this.data.departureAddresses : this.data.arrivalAddresses
    const selected = list[idx]
    const key = type === "departure" ? "departureAddress" : "destinationAddress"

    if (selected === "其他") {
      const res = await wx.showModal({
        title: "",
        editable: true,
        placeholderText: type === "departure" ? "请输入出发地点" : "请输入目的地"
      })

      if (res.confirm && res.content) {
        const v = res.content.trim()
        if (!v) return

        this.setData({ [key]: v }, async () => {
          await this.updateReferencePriceFromRequestPrice()
        })
      }
      return
    }

    this.setData({ [key]: selected }, async () => {
      await this.updateReferencePriceFromRequestPrice()
    })
  },

  // ✅ 核心：查 Request_Price
  async updateReferencePriceFromRequestPrice() {
    const dep = (this.data.departureAddress || "").trim()
    const dest = (this.data.destinationAddress || "").trim()
    if (!dep || !dest) return

    try {
      const db = wx.cloud.database()
      const res = await db.collection("Request_Price")
        .where({ Departure: dep, Destination: dest })
        .limit(1)
        .get()

      const row = (res && res.data && res.data.length) ? res.data[0] : null

      if (row && row.Price !== undefined && row.Price !== null && String(row.Price).trim() !== "") {
        // ✅ 命中：显示数据库价格（不可改）
        this.setData({
          referencePrice: String(row.Price),
          priceLocked: true
        })
      } else {
        // ✅ 未命中：显示提示（不可改）
        this.setData({
          referencePrice: "请参考打车价格",
          priceLocked: true
        })
      }
    } catch (err) {
      console.error("updateReferencePriceFromRequestPrice error:", err)
      // 查询失败也按“未命中”处理，避免阻塞流程
      this.setData({
        referencePrice: "请参考打车价格",
        priceLocked: true
      })
    }
  },

  // -------------------------
  // 日期时间 & 人数
  // -------------------------
  onDateChange(e) { this.setData({ departureDate: e.detail.value }) },
  onTimeChange(e) { this.setData({ departureTime: e.detail.value }) },

  onPassengerInput(e) {
    const num = parseInt(e.detail.value, 10)
    if (isNaN(num) || num < 1 || num > 4) return this.showError("乘客数需为 1-4 的整数")
    this.setData({ passengerCount: num })
  },

  // ✅ 价格不可修改：如果你 WXML 还绑了 input，这里直接忽略
  onReferencePriceInput() {
    // do nothing
  },

  // -------------------------
  // ✅ 点击“发起求车路线”入口
  // -------------------------
  confirmTrip() {
    if (this.data.submitting) return

    // ✅ 关键：先做登录+完善资料拦截
    if (!this.ensureLoginBeforeCreate()) return

    const {
      userInfo, departureAddress, destinationAddress,
      departureDate, departureTime, passengerCount, referencePrice
    } = this.data

    // 登录了但 userInfo 仍为空：兜底提示并带去完善资料
    if (!userInfo) {
      wx.showToast({ title: "请先完善个人信息", icon: "none" })
      wx.setStorageSync("pendingPage", { url: "/pages/home/passengerNewTrip/passengerNewTrip" })
      wx.navigateTo({ url: "/pages/profile/addInfo/addInfo?from=login" })
      return
    }

    if (!departureAddress || !destinationAddress) return this.showError("请选择出发地和目的地")
    if (departureAddress === destinationAddress) return this.showError("出发地与目的地不能相同")
    if (!departureDate || !departureTime) return this.showError("请完善出发日期和时间")

    // ✅ 价格必须有显示（命中会是数字；未命中会是“请参考打车价格”）
    if (!referencePrice || !String(referencePrice).trim()) return this.showError("价格信息缺失，请重新选择地址")

    // 时间限制：>=15分钟，<=30天（你原逻辑保留）
    const selectedTime = this.parseDateTimeSafe(departureDate, departureTime)
    if (!selectedTime || isNaN(selectedTime.getTime())) {
      return this.showError("时间解析失败，请重新选择日期和时间")
    }

    const now = new Date()
    const diffMin = (selectedTime - now) / (1000 * 60)
    if (diffMin < 12) return this.showError("出发时间需晚于当前15分钟")
    if (diffMin > 43200) return this.showError("出发时间不能超过30天")

    const summary =
      `出发：${departureAddress}  ${departureDate} ${departureTime}\n` +
      `到达：${destinationAddress}\n` +
      `人数：${passengerCount}\n` +
      `价格：${referencePrice}`

    this.setData({ submitting: true })

    wx.showModal({
      title: "确认发起求车",
      content: summary,
      success: async (res) => {
        if (!res.confirm) {
          this.setData({ submitting: false })
          return
        }
        await this.submitRequest()
      },
      fail: () => this.setData({ submitting: false })
    })
  },

  // -------------------------
  // 提交：写 CarpoolRequest
  // -------------------------
  async submitRequest() {
    try {
      const {
        userInfo,
        departureAddress, destinationAddress,
        departureDate, departureTime,
        passengerCount, referencePrice
      } = this.data

      if (!userInfo) {
        this.showError("请先完善个人信息")
        return
      }

      const createRes = await wx.cloud.callFunction({
        name: "addCarpoolRequest",
        data: {
          departures: [{ address: departureAddress, date: departureDate, time: departureTime }],
          destinations: [{ address: destinationAddress }],
          passengerCount,

          // ✅ 不再提交大件行李数和备注（保持字段为空/0，避免后端报缺参）
          largeLuggageCount: 0,
          comment: "",

          // ✅ 价格：命中则数据库价格；未命中则“请参考打车价格”
          referencePrice
        }
      })

      const ok = createRes?.result?.success
      const requestId = createRes?.result?.id
      const errMsg = createRes?.result?.errorMsg || createRes?.result?.errMsg || ""

      if (!ok || !requestId) {
        this.showError(errMsg ? `求车创建失败：${errMsg}` : "求车创建失败，请重试")
        return
      }

      wx.showToast({ title: "已发布求车", icon: "success", duration: 1800 })
      setTimeout(() => {
        wx.reLaunch({ url: "/pages/home/home" })
      }, 1200)

    } catch (e) {
      console.error("submitRequest error:", e)
      this.showError("求车创建失败，请重试")
    } finally {
      this.setData({ submitting: false })
    }
  }
})
