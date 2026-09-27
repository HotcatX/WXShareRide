// pages/home/driverCarpoolTemplate/driverCarpoolTemplate.js
const { showDataError } = require("../../../utils/error")
const { callUpdateUser } = require("../../../utils/userProfileUpdate")
const { getDriverRouteDefaultPrice } = require("../../../utils/driverRideDefaults")
const templatesApi = require("../../../utils/compat/rideTemplates")
const profileApi = require("../../../utils/compat/profile")

const { loadRideAddressConfig, getStaticRideAddressConfig } = require("../../../utils/rideAddressConfig")

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
    return Math.min(8, Math.max(1, n))
  },

  async loadTemplateDetail(id) {
    const account = wx.getStorageSync('openid')
    const revision = this._detailRevision = (this._detailRevision || 0) + 1
    try {
      const tpl = await templatesApi.getRideTemplate(id)
      if (!this.isCurrentAccount(account) || revision !== this._detailRevision) return
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

      this._loadedTemplate = tpl
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
        ...(!profileApi.isBackendEnabled() ? { showZelle: tpl.zelle === 'yes' } : {})
      })
    } catch (e) {
      if (!this.isCurrentAccount(account) || revision !== this._detailRevision) return
      console.error('loadTemplateDetail error:', e)
      wx.showToast({ title: '模板加载失败', icon: 'none' })
    }
  },


  onLoad(options) {
    this._disposed = false
    this._editorAccount = wx.getStorageSync("openid") || ""
    const info = typeof wx.getWindowInfo === "function" ? wx.getWindowInfo() : wx.getSystemInfoSync()
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
    const account = wx.getStorageSync("openid") || ""
    if (this._editorAccount !== undefined && this._editorAccount !== account) {
      this._loadedTemplate = null
      this._profileInputDirty = false
      this.setData({ userInfo: null, departureAddress: "", destinationAddress: "", weekdayIndex: -1, weekdayText: "",
        departureTime: "", passengerCount: "", passengerCountInput: "", referencePrice: "", comment: "",
        carNumber: "", carBrand: "", carModel: "", showZelle: false })
      if (this.data.editMode && this.data.templateId && account && !wx.getStorageSync("isGuest")) this.loadTemplateDetail(this.data.templateId)
    }
    this._editorAccount = account
    const tip = wx.getStorageSync("needLoginToast")
    if (tip) {
      wx.removeStorageSync("needLoginToast")
      wx.showToast({ title: tip, icon: "none", duration: 2000 })
    }
    this.loadUserInfo()
  },

  onUnload() { this._disposed = true },

  isCurrentAccount(account) {
    return !this._disposed && !wx.getStorageSync("isGuest") && wx.getStorageSync("openid") === account
  },

  // ===== 登录态判定 =====
  isLoggedIn() {
    const openid = wx.getStorageSync("openid") || ""
    return !!openid && !wx.getStorageSync("isGuest")
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

    const account = wx.getStorageSync("openid")
    const revision = this._userReadRevision = (this._userReadRevision || 0) + 1
    try {
      let user
      if (profileApi.isBackendEnabled()) user = profileApi.legacyDocument(await profileApi.getUserInfo())
      else {
        // TEMPORARY FALLBACK: original CloudBase user read in legacy mode.
        const r = await wx.cloud.database().collection("userInfo").where({ _openid: account }).get()
        user = r && r.data && r.data[0]
      }
      if (!this.isCurrentAccount(account) || revision !== this._userReadRevision) return
      if (!user) throw new Error("用户信息缺失，请先完善个人信息")
      this._userInfoAccount = account

      this.setData({
        userInfo: user,
        ...(!this._profileInputDirty ? {
          carNumber: user.carNumber || "", carBrand: user.carBrand || "", carModel: user.carModel || "",
          ...(profileApi.isBackendEnabled() ? { showZelle: user.defaultShowZelle === true } : {})
        } : {})
      })
    } catch (e) {
      if (!this.isCurrentAccount(account) || revision !== this._userReadRevision) return
      console.error("获取用户信息失败：", e)
      wx.showToast({ title: "获取用户信息失败", icon: "none" })
      this.setData({ userInfo: null })
    }
  },

  // ===== 地址列表（读取 Departure / Arrival）=====
  async loadAllAddresses() {
    this.setData({ loadingDepartureAddrs: true, loadingArrivalAddrs: true })

    try {
      const { fromPlaces: depRes, toPlaces: arrRes } = await loadRideAddressConfig()

      this.setData({
        departureAddresses: [...depRes, "其他"],
        arrivalAddresses: [...arrRes, "其他"],
        loadingDepartureAddrs: false,
        loadingArrivalAddrs: false
      })
    } catch (err) {
      console.error("地址加载失败", err)
      const fallback = getStaticRideAddressConfig()
      this.setData({ departureAddresses: [...fallback.fromPlaces, "其他"], arrivalAddresses: [...fallback.toPlaces, "其他"], loadingDepartureAddrs: false, loadingArrivalAddrs: false })
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
        this.setData({ [fieldName]: res.content.trim() }, () => this.updateReferencePrice())
      }
    } else {
      this.setData({ [fieldName]: selected }, () => this.updateReferencePrice())
    }
  },

  updateReferencePrice() {
    const dep = this.data.departureAddress
    const dest = this.data.destinationAddress
    const userInfo = this.data.userInfo || {}
    this.setData({ referencePrice: getDriverRouteDefaultPrice(dep, dest, userInfo.customPrice) })
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
    this.setData({ passengerCountInput: v, passengerCount: v })
  },


  onCarNumberInput(e) { this._profileInputDirty = true; this.setData({ carNumber: e.detail.value }) },
  onCarBrandInput(e) { this._profileInputDirty = true; this.setData({ carBrand: e.detail.value }) },
  onCarModelInput(e) { this._profileInputDirty = true; this.setData({ carModel: e.detail.value }) },
  onReferencePriceInput(e) { this.setData({ referencePrice: e.detail.value }) },

  onCommentInput(e) {
    this.setData({ comment: e.detail.value })
  },

  onZelleCheckboxChange(e) {
    this._profileInputDirty = true
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

    const account = wx.getStorageSync("openid")
    this.setData({ submitting: true })

    wx.showModal({
      title: "确认保存模板",
      content: summary,
      success: (res) => {
        if (!this.isCurrentAccount(account)) return
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
    const account = wx.getStorageSync("openid") || ""
    if (!this.isCurrentAccount(account) || this._userInfoAccount && this._userInfoAccount !== account) return
    try {

      const {
        editMode,
        templateId,
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
        templateName,

        // 路线模板信息
        departureAddress,
        destinationAddress,
        weekdayIndex,             // 0-6（周一到周日）
        weekdayText,              // "周一"...
        departureTime,            // "HH:mm"

        passengerCount: profileApi.isBackendEnabled() ? passengerCount : this.safeSeat(passengerCount),
        referencePrice,
        comment: comment || "",

        // 车辆信息（模板里也存一份，后续一键带出）
        carNumber,
        carBrand,
        carModel,

        // Zelle
        zelle: showZelle ? "yes" : "no"
      }

      const saved = await templatesApi.saveRideTemplate(payload, { id: editMode ? templateId : undefined, previous: this._loadedTemplate })
      if (!this.isCurrentAccount(account)) return
      this._loadedTemplate = saved
      this.setData({ editMode: true, templateId: saved._id })

      // 不影响模板保存：失败也不回滚模板
      let preferencesSaved = true
      try {
        const updatePayload = {
          action: "afterCreateTemplate",
          carNumber,
          carBrand,
          carModel,
          ...(profileApi.isBackendEnabled() ? { defaultShowZelle: showZelle === true } : {})
        }

        const result = await callUpdateUser(updatePayload)
        if (profileApi.isBackendEnabled() && result?.result?.ok !== true) throw new Error('Profile update was not confirmed')
      } catch (e) {
        preferencesSaved = false
      }

      if (!this.isCurrentAccount(account)) return
      wx.showToast({ title: preferencesSaved ? "模板保存成功" : "模板已保存，车辆设置未更新", icon: preferencesSaved ? "success" : "none", duration: 1800 })
      setTimeout(() => { if (this.isCurrentAccount(account)) wx.navigateBack() }, 1200)
    } catch (e) {
      if (!this.isCurrentAccount(account)) return
      if (e && e.code === 'PENDING_OPERATION') {
        try {
          const recovered = await templatesApi.recoverRideTemplate(this.data.editMode ? this.data.templateId : undefined)
          if (!this.isCurrentAccount(account)) return
          if (recovered) {
            // Reconcile the old creation/update under its original key. Keep
            // current form input; another explicit save PATCHes this same ID.
            this._loadedTemplate = recovered
            this.setData({ editMode: true, templateId: recovered._id })
            this.showError('已找回上次模板，请再保存当前内容')
            return
          }
        } catch (_) { /* Keep the uncertain receipt and the current form. */ }
        if (!this.isCurrentAccount(account)) return
        this.showError('上次保存结果待确认，请稍后重试')
        return
      }
      console.error("保存模板异常：", e)
      this.showError(e && e.code === "PENDING_OPERATION" ? "上次保存未确认，请保持内容后重试" : "模板保存失败，请重试")
    } finally {
      if (!this._disposed) this.setData({ submitting: false })
    }
  }
})
