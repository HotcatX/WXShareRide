// pages/home/driverCarpoolTemplate/driverCarpoolTemplate.js
const { showDataError } = require("../../../utils/error")

Page({
  data: {
    editMode: false,
    templateId: '',

    userInfo: null,

    statusBarHeight: 80,
    pageTitle: "出行模板",

    // 地址下拉列表
    departureAddresses: [],
    arrivalAddresses: [],
    loadingDepartureAddrs: true,
    loadingArrivalAddrs: true,

    // 出发 / 目的地
    departureAddress: "",
    destinationAddress: "",

    // ✅ 星期几（替代日期）
    weekdayOptions: ["周一", "周二", "周三", "周四", "周五", "周六", "周日"],
    weekdayIndex: -1,
    weekdayText: "",
    departureTime: "",

    passengerCount: "",

    // 车辆信息
    carNumber: "",
    carBrand: "",
    carModel: "",

    // 参考价格 & 备注
    referencePrice: "",
    comment: "",

    // 常用备注
    // commonComments: [],
    // commentSelectedFromCommon: false,
    // lastCommentBlurValue: "",

    // Zelle
    showZelle: false,

    submitting: false
  },

  safeSeat(val) {
    const n = parseInt(val, 10)
    if (isNaN(n)) return 1
    return Math.min(7, Math.max(1, n))
  },

  async loadTemplateDetail(id) {
    try {
      const db = wx.cloud.database()
      const res = await db.collection('CarpoolTemplate').doc(id).get()
      const tpl = res && res.data ? res.data : null
      if (!tpl) {
        wx.showToast({ title: '未找到该模板', icon: 'none' })
        return
      }

      // 安全：只允许编辑自己的模板（避免被别人 id 猜到）
      const myOpenid = wx.getStorageSync('openid') || ''
      if (myOpenid && tpl._openid && tpl._openid !== myOpenid) {
        wx.showToast({ title: '无权限编辑该模板', icon: 'none' })
        return
      }

      const seat = this.safeSeat(tpl.passengerCount)

      this.setData({
        departureAddress: tpl.departureAddress || '',
        destinationAddress: tpl.destinationAddress || '',

        weekdayIndex: typeof tpl.weekdayIndex === 'number' ? tpl.weekdayIndex : -1,
        weekdayText: tpl.weekdayText || '',
        departureTime: tpl.departureTime || '',

        passengerCount: seat,
        passengerCountInput: String(seat),

        referencePrice: tpl.referencePrice || '',
        comment: tpl.comment || '',

        // 模板存的是 zelle: "yes"/"no"
        showZelle: tpl.zelle === 'yes'
      })
    } catch (e) {
      console.error('loadTemplateDetail error:', e)
      wx.showToast({ title: '模板加载失败', icon: 'none' })
    }
  },


  onLoad(options) {
    const info = wx.getSystemInfoSync()
    this.setData({ statusBarHeight: info.statusBarHeight })

    this.loadAllAddresses()
    this.loadUserInfo()

    const id = options && options.id ? String(options.id) : ''
    if (id) {
      this.setData({ editMode: true, templateId: id }, () => {
        this.loadTemplateDetail(id)
      })
    }
  },


  onShow() {
    const tip = wx.getStorageSync("needLoginToast")
    if (tip) {
      wx.removeStorageSync("needLoginToast")
      wx.showToast({ title: tip, icon: "none", duration: 2000 })
    }
    this.loadUserInfo()
  },

  // ===== 登录态判定 =====
  isLoggedIn() {
    const openid = wx.getStorageSync("openid") || ""
    return !!openid
  },

  ensureLoginBeforeCreate() {
    if (this.isLoggedIn()) return true

    wx.setStorageSync("pendingPage", { url: "/pages/home/driverCarpoolTemplate/driverCarpoolTemplate" })
    wx.setStorageSync("postLoginAction", {
      type: "requireProfile",
      returnUrl: "/pages/home/driverCarpoolTemplate/driverCarpoolTemplate"
    })

    wx.navigateTo({ url: "/pages/other/login/login" })
    return false
  },

  ensureWechatIdBeforeCreate() {
    const user = this.data.userInfo || {}
    const wechatID = (user.wechatID || "").trim()
    if (wechatID) return true

    wx.showModal({
      title: "请先填写微信号",
      content: "检测到你还未填写微信号。请到「个人中心」完善后再创建模板。",
      showCancel: false,
      confirmText: "我知道了"
    })
    return false
  },

  // ===== userInfo =====
  async loadUserInfo() {
    if (!this.isLoggedIn()) {
      this.setData({ userInfo: null })
      return
    }

    try {
      const db = wx.cloud.database()
      const openid = wx.getStorageSync("openid") || ""

      const r = await db.collection("userInfo").where({ _openid: openid }).get()
      if (!r.data || r.data.length === 0) {
        wx.showToast({ title: "用户信息缺失，请先完善个人信息", icon: "none" })
        this.setData({ userInfo: null })
        return
      }

      const user = r.data[0]

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

  // ===== 地址列表（读取 Departure / Arrival）=====
  async loadAllAddresses() {
    this.setData({ loadingDepartureAddrs: true, loadingArrivalAddrs: true })

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
      showDataError("地址加载失败", err, "地址配置从数据库加载失败，请稍后重试。")
      this.setData({ loadingDepartureAddrs: false, loadingArrivalAddrs: false })
    }
  },

  async loadAddressList(type) {
    try {
      const db = wx.cloud.database()
      const res = await db.collection(type).get()

      if (!res.data || res.data.length === 0) {
        throw new Error(`集合 ${type} 为空`)
      }

      const record = { ...res.data[0] }
      delete record._id

      const addressList = Object.keys(record)
        .map(k => record[k])
        .filter(v => v !== undefined && v !== null && String(v).trim() !== "")

      return addressList
    } catch (e) {
      console.error("地址列表数据库加载失败：", e)
      throw e
    }
  },

  goBack() { wx.navigateBack() },

  // ===== 地址选择 + 自动参考价格（沿用）=====
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
        this.setData({ [fieldName]: res.content, referencePrice: "价格私议" })
      }
    } else {
      this.setData({ [fieldName]: selected }, () => this.updateReferencePrice())
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

  // ===== 输入事件 =====
  onWeekdayChange(e) {
    const idx = Number(e.detail.value)
    const text = this.data.weekdayOptions[idx] || ""
    this.setData({ weekdayIndex: idx, weekdayText: text })
  },

  onTimeChange(e) { this.setData({ departureTime: e.detail.value }) },

  onPassengerInput(e) {
    const v = String(e.detail.value || '')
    this.setData({ passengerCountInput: v })
  },


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
  // ✅ 点击“保存出行模板”
  // ===========================
  confirmTemplate() {
    if (!this.ensureLoginBeforeCreate()) return
    if (this.data.submitting) return

    const {
      userInfo,
      departureAddress,
      destinationAddress,
      weekdayIndex,
      weekdayText,
      departureTime,
      passengerCount,
      carNumber,
      carBrand,
      carModel,
      referencePrice
    } = this.data

    if (!userInfo) {
      wx.showToast({ title: "请先在个人中心完善信息", icon: "none", duration: 2000 })
      return
    }
    if (!this.ensureWechatIdBeforeCreate()) return

    // 基础校验（模板不做“30天/15分钟”这种真实时间窗口）
    if (!departureAddress || !destinationAddress) return this.showError("请选择出发地和目的地")
    if (departureAddress === destinationAddress) return this.showError("出发地与目的地不能相同")
    if (weekdayIndex < 0 || !weekdayText) return this.showError("请选择星期几")
    if (!departureTime) return this.showError("请选择时间")

    if (!carNumber || !carBrand || !carModel) return this.showError("请完整填写车牌号、车辆品牌和型号")
    if (!referencePrice || !String(referencePrice).trim()) return this.showError("请填写参考价格")

    const templateName = `${weekdayText} ${departureAddress}→${destinationAddress}`

    const summary =
      `模板名：${templateName}\n` +
      `出发：${departureAddress}  ${weekdayText} ${departureTime}\n` +
      `到达：${destinationAddress}\n` +
      `载客数：${passengerCount}\n` +
      `参考价格：${referencePrice}\n` +
      `公开 Zelle 信息：${this.data.showZelle ? "是" : "否"}`

    this.setData({ submitting: true })

    wx.showModal({
      title: "确认保存模板",
      content: summary,
      success: (res) => {
        if (res.confirm) this.submitTemplate(templateName)
        else this.setData({ submitting: false })
      },
      fail: () => this.setData({ submitting: false })
    })
  },

  // ===========================
  // ✅ 真正写入 CarpoolTemplate
  // ===========================
  async submitTemplate(templateName) {
    try {
      const db = wx.cloud.database()
      const openid = wx.getStorageSync("openid") || ""

      const {
        userInfo,
        departureAddress,
        destinationAddress,
        weekdayIndex,
        weekdayText,
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

      const payload = {
        // 归属
        // _openid: openid,
        driverID: userInfo._id,   // 你项目里常用 userInfo._id
        templateName,

        // 路线模板信息
        departureAddress,
        destinationAddress,
        weekdayIndex,             // 0-6（周一到周日）
        weekdayText,              // "周一"...
        departureTime,            // "HH:mm"

        passengerCount: this.safeSeat(passengerCount),
        referencePrice,
        comment: comment || "",

        // 车辆信息（模板里也存一份，后续一键带出）
        carNumber,
        carBrand,
        carModel,

        // Zelle
        zelle: showZelle ? "yes" : "no",

        // 时间戳
        createdAt: db.serverDate()
      }

      const addRes = await db.collection("CarpoolTemplate").add({ data: payload })
      if (!addRes || !addRes._id) {
        this.showError("模板保存失败，请重试")
        return
      }

      // 不影响模板保存：失败也不回滚模板
      try {
        const updatePayload = {
          action: "afterCreateTemplate",
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

        await wx.cloud.callFunction({ name: "updateUserCreateTrip", data: updatePayload })
      } catch (e) {
      }

      wx.showToast({ title: "模板保存成功", icon: "success", duration: 1800 })
      setTimeout(() => wx.navigateBack(), 1200)
    } catch (e) {
      console.error("保存模板异常：", e)
      this.showError("模板保存失败，请重试")
    } finally {
      this.setData({ submitting: false })
    }
  }
})
