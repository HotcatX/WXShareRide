// pages/home/CarpoolTemplateList/CarpoolTemplateList.js
const { showDataError } = require("../../../utils/error")

const WEEKDAY_LABELS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]

function templateWeekdayIndex(tpl) {
  if (Number.isInteger(tpl.weekdayIndex) && tpl.weekdayIndex >= 0 && tpl.weekdayIndex <= 6) {
    return tpl.weekdayIndex
  }
  const match = /^(?:每周|周|星期)([一二三四五六日天])$/.exec(String(tpl.weekdayText || "").trim())
  if (!match) return -1
  return "一二三四五六日".indexOf(match[1] === "天" ? "日" : match[1])
}

function templateTime(time) {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/.exec(String(time || "").trim())
  return match ? `${match[1].padStart(2, "0")}:${match[2]}` : ""
}

Page({
  data: {
    statusBarHeight: 80,
    pageTitle: "每周出行模板",

    currentRole: "driver",
    loading: false,
    templateList: [],

    // ✅ 删除模式：开启后点击卡片=删除；关闭后点击卡片=编辑
    deleteMode: false,

    // ===================== 乘客：常用地址 =====================
    pickupSpotList: [],
    dropoffSpotList: [],

    pickupEditing: false,
    dropoffEditing: false,

    pickupInput: "",
    dropoffInput: "",

    savingPickup: false,
    savingDropoff: false,

    pickupDeleteMode: false,
    dropoffDeleteMode: false,

  },

  async onLoad() {
    const info = typeof wx.getWindowInfo === "function" ? wx.getWindowInfo() : wx.getSystemInfoSync()
    this.setData({ statusBarHeight: info.statusBarHeight })
    await this.loadByRoleIfNeeded()
  },

  async onShow() {
    await this.loadByRoleIfNeeded()
  },

  goBack() {
    const pages = getCurrentPages()
    if (pages.length > 1) wx.navigateBack()
    else wx.reLaunch({ url: "/pages/home/home" })
  },

  switchRole(e) {

    const role = e.currentTarget.dataset.role
    if (!role || role === this.data.currentRole) return

    // 切身份时退出删除模式 / 退出编辑态，避免误操作
    this.setData(
      {
        currentRole: role,
        deleteMode: false,
        pickupEditing: false,
        dropoffEditing: false,
        pickupInput: "",
        dropoffInput: "",
        pickupDeleteMode: false,
        dropoffDeleteMode: false,
      },
      () => this.loadByRoleIfNeeded()
    )
  },

  isLoggedIn() {
    const openid = wx.getStorageSync("openid") || ""
    return !!openid
  },

  async loadByRoleIfNeeded() {
    if (this.data.currentRole === "driver") {
      await this.loadTemplateList()
      return
    }
    // passenger
    await this.loadUserSpots()
  },

  // ===================== 司机：每周模板列表 =====================

  // 读取本人模板后按每周课表排序，不修改已有模板数据。
  async loadTemplateList() {
    if (!this.isLoggedIn()) {
      this.setData({ templateList: [], loading: false })
      wx.showToast({ title: "请先登录后查看模板", icon: "none" })
      return
    }

    this.setData({ loading: true })

    try {
      const db = wx.cloud.database()
      const openid = wx.getStorageSync("openid") || ""

      // 分页拉取
      const pageSize = 100
      let all = []
      let skip = 0

      while (true) {
        const r = await db
          .collection("CarpoolTemplate")
          .where({ _openid: openid })
          .orderBy("createdAt", "desc")
          .skip(skip)
          .limit(pageSize)
          .get()

        const batch = r && r.data ? r.data : []
        all = all.concat(batch)

        if (batch.length < pageSize) break
        skip += pageSize
        if (all.length >= 2000) break
      }

      const decorated = this.decorateTemplateList(all || [])
      this.setData({ templateList: decorated, loading: false })
    } catch (e) {
      console.error("loadTemplateList error:", e)
      wx.showToast({ title: "模板加载失败", icon: "none" })
      this.setData({ templateList: [], loading: false })
    }
  },

  decorateTemplateList(list) {
    return (Array.isArray(list) ? list : [])
      .filter(tpl => tpl && typeof tpl === "object" && !Array.isArray(tpl))
      .map((tpl, order) => {
        const weekdayIndex = templateWeekdayIndex(tpl)
        const time = templateTime(tpl.departureTime)
        return {
          order,
          weekdayOrder: weekdayIndex < 0 ? 7 : weekdayIndex,
          timeOrder: time || "99:99",
          template: {
            ...tpl,
            _fromAddress: String(tpl.departureAddress || "").trim(),
            _toAddress: String(tpl.destinationAddress || "").trim(),
            _timeLabel: `${weekdayIndex < 0 ? "星期待设置" : `每${WEEKDAY_LABELS[weekdayIndex]}`} ${time || "时间待设置"}`
          }
        }
      })
      .sort((a, b) => a.weekdayOrder - b.weekdayOrder || a.timeOrder.localeCompare(b.timeOrder) || a.order - b.order)
      .map(item => item.template)
  },

  weekTextFromIndex(idx) {
    if (Number.isInteger(idx) && idx >= 0 && idx <= 6) return WEEKDAY_LABELS[idx]
    return ""
  },

  formatTimeOnly(timeStr) {
    return templateTime(timeStr)
  },

  onTemplateCardTap(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return

    if (this.data.deleteMode) {
      this.confirmDelete(id)
      return
    }

    wx.navigateTo({ url: `/pages/home/driverCarpoolTemplate/driverCarpoolTemplate?id=${id}` })
  },

  goAddTemplate() {
    if (!this.isLoggedIn()) {
      wx.setStorageSync("pendingPage", { url: "/pages/home/CarpoolTemplateList/CarpoolTemplateList" })
      wx.setStorageSync("postLoginAction", {
        type: "requireProfile",
        returnUrl: "/pages/home/CarpoolTemplateList/CarpoolTemplateList"
      })
      wx.navigateTo({ url: "/pages/other/login/login" })
      return
    }
    wx.navigateTo({ url: "/pages/home/driverCarpoolTemplate/driverCarpoolTemplate" })
  },

  toggleDeleteMode() {
    const next = !this.data.deleteMode
    this.setData({ deleteMode: next })

    if (next) {
      wx.showToast({ title: "删除模式：点击模板即可删除", icon: "none", duration: 1800 })
    }
  },

  confirmDelete(id) {
    wx.showModal({
      title: "删除模板",
      content: "确定删除该模板吗？删除后不可恢复。",
      confirmText: "删除",
      confirmColor: "#d93025",
      cancelText: "取消",
      success: (res) => {
        if (res.confirm) this.deleteTemplateById(id)
      }
    })
  },

  async deleteTemplateById(id) {
    try {
      const db = wx.cloud.database()
      await db.collection("CarpoolTemplate").doc(id).remove()
      wx.showToast({ title: "已删除", icon: "success", duration: 1200 })
      await this.loadTemplateList()
    } catch (e) {
      console.error("deleteTemplateById error:", e)
      wx.showToast({ title: "删除失败，请重试", icon: "none" })
    }
  },


  async loadUserSpots() {
    // 未登录：只展示空态，不弹 toast（避免打扰）
    if (!this.isLoggedIn()) {
      this.setData({
        pickupSpotList: [],
        dropoffSpotList: [],
        pickupEditing: false,
        dropoffEditing: false,
        pickupInput: "",
        dropoffInput: ""
      })
      return
    }

    try {
      const db = wx.cloud.database()
      const openid = wx.getStorageSync("openid") || ""

      // ⚠️ 这里默认你的 collection 名叫 userInfo
      // 如果你实际叫 UserInfo / Users / user_info，把这行改掉即可
      const r = await db.collection("userInfo").where({ _openid: openid }).limit(1).get()
      const info = (r && r.data && r.data[0]) ? r.data[0] : null

      const pickup = Array.isArray(info?.pickupSpot) ? info.pickupSpot : []
      const dropoff = Array.isArray(info?.dropoffSpot) ? info.dropoffSpot : []

      this.setData({
        pickupSpotList: this.normalizeSpotList(pickup),
        dropoffSpotList: this.normalizeSpotList(dropoff)
      })
    } catch (e) {
      console.error("loadUserSpots error:", e)
      showDataError("常用地址加载失败", e, "常用地址从数据库加载失败，请稍后重试。")
    }
  },

  normalizeSpotList(arr) {
    const out = []
    const seen = new Set()
    ;(arr || []).forEach((x) => {
      const s = String(x || "").trim()
      if (!s) return
      if (seen.has(s)) return
      seen.add(s)
      out.push(s)
    })
    return out
  },

  onPickupInput(e) {
    this.setData({ pickupInput: e.detail.value })
  },

  onDropoffInput(e) {
    this.setData({ dropoffInput: e.detail.value })
  },

  async onPickupBtnTap() {
    if (!this.isLoggedIn()) {
      wx.showToast({ title: "请先登录后再添加常用出发地", icon: "none" })
      return
    }

    // 从“+”进入编辑态
    if (!this.data.pickupEditing) {
      this.setData({ pickupEditing: true, pickupInput: "" })
      return
    }

    // 保存
    if (this.data.savingPickup) return
    const val = String(this.data.pickupInput || "").trim()
    if (!val) {
      wx.showToast({ title: "请输入出发地", icon: "none" })
      return
    }

    await this.appendSpotToUserInfo("pickupSpot", val)
    this.setData({ pickupEditing: false, pickupInput: "" })
  },

  async onDropoffBtnTap() {
    if (!this.isLoggedIn()) {
      wx.showToast({ title: "请先登录后再添加常用目的地", icon: "none" })
      return
    }

    if (!this.data.dropoffEditing) {
      this.setData({ dropoffEditing: true, dropoffInput: "" })
      return
    }

    if (this.data.savingDropoff) return
    const val = String(this.data.dropoffInput || "").trim()
    if (!val) {
      wx.showToast({ title: "请输入目的地", icon: "none" })
      return
    }

    await this.appendSpotToUserInfo("dropoffSpot", val)
    this.setData({ dropoffEditing: false, dropoffInput: "" })
  },

  async appendSpotToUserInfo(field, value) {
    const db = wx.cloud.database()
    const _ = db.command
    const openid = wx.getStorageSync("openid") || ""

    const savingKey = field === "pickupSpot" ? "savingPickup" : "savingDropoff"
    this.setData({ [savingKey]: true })

    try {
      // 先找 userInfo 文档
      const r = await db.collection("userInfo").where({ _openid: openid }).limit(1).get()
      const info = (r && r.data && r.data[0]) ? r.data[0] : null

      if (!info || !info._id) {
        // 没有就新建：字段为数组
        await db.collection("userInfo").add({
          data: {
            [field]: [value]
          }
        })
      } else {
        // 有就追加：addToSet 去重（推荐）
        await db.collection("userInfo").doc(info._id).update({
          data: {
            [field]: _.addToSet(value)
          }
        })
      }

      // 重新拉取/或本地更新
      await this.loadUserSpots()
      wx.showToast({ title: "已保存", icon: "success" })
    } catch (e) {
      console.error("appendSpotToUserInfo error:", e)
      wx.showToast({ title: "保存失败，请重试", icon: "none" })
    } finally {
      this.setData({ [savingKey]: false })
    }
  },

  togglePickupDeleteMode() {
    if (!this.isLoggedIn()) {
      wx.showToast({ title: "请先登录", icon: "none" })
      return
    }
    const next = !this.data.pickupDeleteMode
    this.setData({
      pickupDeleteMode: next,
      pickupEditing: next ? false : this.data.pickupEditing,
      pickupInput: next ? "" : this.data.pickupInput
    })
  },

  toggleDropoffDeleteMode() {
    if (!this.isLoggedIn()) {
      wx.showToast({ title: "请先登录", icon: "none" })
      return
    }
    const next = !this.data.dropoffDeleteMode
    this.setData({
      dropoffDeleteMode: next,
      dropoffEditing: next ? false : this.data.dropoffEditing,
      dropoffInput: next ? "" : this.data.dropoffInput
    })
  },

  async onPickupTagTap(e) {
    if (!this.data.pickupDeleteMode) return
    const value = (e.currentTarget.dataset.value || "").trim()
    if (!value) return
    await this.removeSpotFromUserInfo("pickupSpot", value)
  },

  async onDropoffTagTap(e) {
    if (!this.data.dropoffDeleteMode) return
    const value = (e.currentTarget.dataset.value || "").trim()
    if (!value) return
    await this.removeSpotFromUserInfo("dropoffSpot", value)
  },

  async removeSpotFromUserInfo(field, value) {
    const db = wx.cloud.database()
    const _ = db.command
    const openid = wx.getStorageSync("openid") || ""

    try {
      const r = await db.collection("userInfo").where({ _openid: openid }).limit(1).get()
      const info = (r && r.data && r.data[0]) ? r.data[0] : null
      if (!info || !info._id) return

      // 从数组移除指定值
      await db.collection("userInfo").doc(info._id).update({
        data: {
          [field]: _.pull(value)
        }
      })

      // 刷新列表
      await this.loadUserSpots()
      wx.showToast({ title: "已删除", icon: "success" })

      // 如果删空了，自动退出删除模式，避免“完成”按钮还在
      if (field === "pickupSpot" && (!this.data.pickupSpotList || this.data.pickupSpotList.length === 0)) {
        this.setData({ pickupDeleteMode: false })
      }
      if (field === "dropoffSpot" && (!this.data.dropoffSpotList || this.data.dropoffSpotList.length === 0)) {
        this.setData({ dropoffDeleteMode: false })
      }
    } catch (e) {
      console.error("removeSpotFromUserInfo error:", e)
      wx.showToast({ title: "删除失败，请重试", icon: "none" })
    }
  },

})
