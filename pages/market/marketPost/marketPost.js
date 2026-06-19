const MARKET_MAIN_IMAGE_QUALITY = 52
const MARKET_THUMB_IMAGE_QUALITY = 42
const MARKET_MAIN_IMAGE_MAX_SIDE = 1280
const MARKET_MAIN_CANVAS_QUALITY = 0.78
const MARKET_THUMB_CANVAS_QUALITY = 0.72
const MARKET_PICKUP_MAX_MONTHS = 2
const MARKET_DEFAULT_PICKUP_DAYS = 14
const { showDataError } = require("../../../utils/error")

// ========== 图片压缩（上传前压缩，压缩失败使用原图，保证不出错） ==========
function compressForUpload(srcPath, quality = 70) {
  return new Promise(resolve => {
    if (!srcPath) return resolve(srcPath)
    wx.compressImage({
      src: srcPath,
      quality,
      success: res => resolve(res.tempFilePath || srcPath),
      fail: () => resolve(srcPath)
    })
  })
}

function resizeMainImageForUpload(page, imgPath) {
  return new Promise(resolve => {
    if (!imgPath) return resolve("")

    wx.getImageInfo({
      src: imgPath,
      success: info => {
        const w = Number(info.width) || 0
        const h = Number(info.height) || 0
        if (!w || !h) {
          resolve(imgPath)
          return
        }

        const longest = Math.max(w, h)
        if (longest <= MARKET_MAIN_IMAGE_MAX_SIDE) {
          resolve(imgPath)
          return
        }

        const scale = MARKET_MAIN_IMAGE_MAX_SIDE / longest
        const targetW = Math.max(1, Math.round(w * scale))
        const targetH = Math.max(1, Math.round(h * scale))
        const ctx = wx.createCanvasContext("mainCompressCanvas", page)

        ctx.clearRect(0, 0, MARKET_MAIN_IMAGE_MAX_SIDE, MARKET_MAIN_IMAGE_MAX_SIDE)
        ctx.drawImage(imgPath, 0, 0, w, h, 0, 0, targetW, targetH)
        ctx.draw(false, () => {
          wx.canvasToTempFilePath(
            {
              canvasId: "mainCompressCanvas",
              width: targetW,
              height: targetH,
              destWidth: targetW,
              destHeight: targetH,
              fileType: "jpg",
              quality: MARKET_MAIN_CANVAS_QUALITY,
              success: r => resolve(r.tempFilePath || imgPath),
              fail: () => resolve(imgPath)
            },
            page
          )
        })
      },
      fail: () => resolve(imgPath)
    })
  })
}

async function prepareMainImageForUpload(page, imgPath) {
  const resizedPath = await resizeMainImageForUpload(page, imgPath)
  return compressForUpload(resizedPath || imgPath, MARKET_MAIN_IMAGE_QUALITY)
}

// ========== 生成缩略图（canvas，把第一张图做成 300x300） ==========
function genThumbFromFirstImage(page, imgPath) {
  return new Promise(resolve => {
    if (!imgPath) return resolve("")
    const ctx = wx.createCanvasContext("thumbCanvas", page)
    const size = 300

    wx.getImageInfo({
      src: imgPath,
      success: info => {
        const w = info.width
        const h = info.height
        // 中心裁剪成正方形
        const side = Math.min(w, h)
        const sx = (w - side) / 2
        const sy = (h - side) / 2

        ctx.clearRect(0, 0, size, size)
        ctx.drawImage(imgPath, sx, sy, side, side, 0, 0, size, size)
        ctx.draw(false, () => {
          wx.canvasToTempFilePath(
            {
              canvasId: "thumbCanvas",
              width: size,
              height: size,
              destWidth: size,
              destHeight: size,
              fileType: "jpg",
              quality: MARKET_THUMB_CANVAS_QUALITY,
              success: r => resolve(r.tempFilePath || ""),
              fail: () => resolve("")
            },
            page
          )
        })
      },
      fail: () => resolve("")
    })
  })
}

// ========== 上传单张到云存储 ==========
function uploadOne(localPath, folder = "market", onProgress) {
  if (!localPath) return Promise.resolve("")
  const match = String(localPath).match(/\.([a-z0-9]+)(?:\?|$)/i)
  const rawExt = match ? match[1].toLowerCase() : "jpg"
  const ext = ["jpg", "jpeg", "png", "gif", "webp", "bmp"].includes(rawExt) ? rawExt : "jpg"
  const cloudPath = `${folder}/${Date.now()}_${Math.random().toString(16).slice(2)}.${ext}`

  return new Promise((resolve, reject) => {
    const uploadTask = wx.cloud.uploadFile({
      cloudPath,
      filePath: localPath,
      success: res => resolve(res.fileID || ""),
      fail: reject
    })

    if (uploadTask && typeof uploadTask.onProgressUpdate === "function") {
      uploadTask.onProgressUpdate(res => {
        if (typeof onProgress === "function") {
          onProgress(Math.max(0, Math.min(100, Number(res.progress) || 0)))
        }
      })
    }
  })
}

function normalizeFileID(fileID) {
  const value = String(fileID || "").trim()
  return value.startsWith("cloud://") ? value : ""
}

function uniqFileIDs(fileIDs) {
  return Array.from(new Set((fileIDs || []).map(normalizeFileID).filter(Boolean)))
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function addMonths(date, months) {
  const d = new Date(date.getTime())
  const day = d.getDate()
  d.setMonth(d.getMonth() + months)
  if (d.getDate() !== day) d.setDate(0)
  return d
}

function addDays(date, days) {
  const d = new Date(date.getTime())
  d.setDate(d.getDate() + days)
  return d
}

function formatDate(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

function parseDate(value) {
  const text = String(value || "").trim()
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (!match) return null
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  if (formatDate(date) !== text) return null
  return date
}

function endOfDayTime(value) {
  const d = parseDate(value)
  if (!d) return 0
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime()
}

function buildDefaultPickupWindow() {
  const today = startOfDay(new Date())
  const max = addMonths(today, MARKET_PICKUP_MAX_MONTHS)
  const defaultEnd = addDays(today, MARKET_DEFAULT_PICKUP_DAYS)
  const safeEnd = defaultEnd > max ? max : defaultEnd
  const start = formatDate(today)
  const end = formatDate(safeEnd)
  const maxText = formatDate(max)
  return {
    pickupStartMin: start,
    pickupStartMax: maxText,
    pickupEndMin: start,
    pickupEndMax: maxText,
    pickupStartDate: start,
    pickupEndDate: end,
    pickupRangeText: `${start} 至 ${end}`
  }
}

function normalizePickupWindow(startText, endText) {
  const base = buildDefaultPickupWindow()
  const minDate = parseDate(base.pickupStartMin)
  const maxDate = parseDate(base.pickupEndMax)
  let startDate = parseDate(startText) || parseDate(base.pickupStartDate)
  let endDate = parseDate(endText) || parseDate(base.pickupEndDate)

  if (startDate < minDate) startDate = minDate
  if (startDate > maxDate) startDate = maxDate
  if (endDate < startDate) endDate = startDate
  if (endDate > maxDate) endDate = maxDate

  const start = formatDate(startDate)
  const end = formatDate(endDate)
  return {
    ...base,
    pickupEndMin: start,
    pickupStartDate: start,
    pickupEndDate: end,
    pickupRangeText: `${start} 至 ${end}`
  }
}

function registerUploadedMarketFiles(files, goodsId = "") {
  const payload = (files || []).filter(file => file && file.fileID)
  if (!payload.length) return Promise.resolve()
  return wx.cloud.callFunction({
    name: "trackMarketFiles",
    data: {
      goodsId,
      status: goodsId ? "attached" : "uploaded",
      files: payload
    }
  }).catch(e => {
  })
}

function normalizeLocationText(value) {
  return String(value || "").replace(/\s+/g, " ").trim()
}

function buildLocationMeta(displayName, source = {}) {
  const name = normalizeLocationText(displayName || source.displayName || source.name || source.address)
  if (!name) return {}

  const parts = name.split("/").map(s => s.trim()).filter(Boolean)
  const legacyState = parts[0] || ""
  const legacyArea = parts[1] || ""
  const legacyBuilding = parts.slice(2).join(" / ")

  return {
    displayName: name,
    buildingName: source.buildingName || legacyBuilding || "",
    city: source.city || legacyArea || "",
    state: source.state || legacyState || "",
    zip: source.zip || "",
    country: source.country || "US",
    lat: typeof source.lat === "number" ? source.lat : null,
    lng: typeof source.lng === "number" ? source.lng : null,
    address: source.address || "",
    source: source.source || "manual"
  }
}

function isEmptyProfileRegion(value) {
  const parts = normalizeLocationText(value).split("/").map(s => s.trim()).filter(Boolean)
  if (!parts.length) return true
  return parts.every(part => part === "无" || part === "—")
}

function buildProfileLocationDisplay(user = {}) {
  const bigregion = normalizeLocationText(user.bigregion)
  const address = normalizeLocationText(user.address || user.location?.displayName)
  const hasRegion = bigregion && !isEmptyProfileRegion(bigregion)

  if (hasRegion) {
    const regionParts = bigregion.split("/").map(s => s.trim()).filter(Boolean)
    if (regionParts.length >= 3 || !address) return bigregion
    if (address.includes("/")) return address
    if (regionParts.includes(address)) return bigregion
    return `${bigregion} / ${address}`
  }

  return address
}

// ========== 分类 / 常用语 / 新旧程度 ==========
const CATEGORY_OPTIONS = [
 "家具", "厨具", "服包鞋饰", "电子产品", "运动装备", "食品", "其他"
]
const QUICK_PHRASES = [
  "几乎全新，使用很少",
  "可小刀，爽快优先",
  "配件齐全，功能正常",
  "搬家出闲置，急出"
]
const CONDITION_OPTIONS = ["全新", "99新", "9新", "7新", "5新", "3新"]

Page({
  data: {
    statusBarHeight: 0,

    // ✅ 编辑模式
    isEdit: false,
    editId: '',
    editLoading: false,

    // image 仅用于预览（本地路径）
    image: "",
    imageFileID: "",

    images: [],
    imageFileIDs: [],
    thumbFileID: "",
    thumbFileIDs: [],
    imageUploading: false,
    imageUploadProgress: 0,
    imageUploadProgressDeg: 0,
    imageUploadText: "上传中",

    title: "",
    desc: "",

    category: "其他",
    price: "",
    condition: "99新",
    region: "",
    locationInput: "",
    location: {},
    ...buildDefaultPickupWindow(),

    categoryOptions: CATEGORY_OPTIONS,
    categoryIndex: CATEGORY_OPTIONS.indexOf("其他"),
    profileWechatID: "",

    quickPhrases: QUICK_PHRASES,

    // condition sheet
    conditionSheetVisible: false,
    conditionOptions: CONDITION_OPTIONS,

    submitting: false
  },

  onLoad(options) {
    const sys = wx.getSystemInfoSync()
    const id = options?.id || ''
    const mode = options?.mode || ''
    const isEdit = !!id && String(mode).toLowerCase() === 'edit'

    this.setData({
      statusBarHeight: sys.statusBarHeight || 0,
      isEdit,
      editId: isEdit ? id : '',
      ...normalizePickupWindow(this.data.pickupStartDate, this.data.pickupEndDate)
    })

    if (isEdit) {
      this._loadExistingItem(id)
    } else {
      this._applyDefaultLocation()
    }
    this._hasLoaded = true
  },

  onShow() {
    if (!this._hasLoaded || this.data.isEdit || this._locationTouched) return
    this._applyProfileLocation()
  },

  async _applyDefaultLocation() {
    await this._applyProfileLocation()
  },

  async _applyProfileLocation() {
    if (this.data.isEdit || this._locationTouched) return false

    try {
      const res = await wx.cloud.callFunction({ name: "getUserInfo" })
      const user = (res?.result?.data || [])[0] || null
      const profileWechatID = normalizeLocationText(user?.wechatID)
      const displayName = buildProfileLocationDisplay(user || {})
      if (this.data.isEdit || this._locationTouched) return false
      if (!displayName) {
        this.setData({ profileWechatID })
        return false
      }

      const location = buildLocationMeta(displayName, {
        ...(user?.location || {}),
        source: user?.location ? (user.location.source || "profile") : "profile"
      })
      this.setData({
        profileWechatID,
        region: displayName,
        locationInput: displayName,
        location
      })
      return true
    } catch (e) {
      showDataError("资料加载失败", e, "个人资料从数据库加载失败，请稍后重试。")
      return false
    }
  },

  // =========================
  // 编辑模式：加载已有商品并回填表单
  // =========================
  async _loadExistingItem(id) {
    // 编辑必须登录
    const myOpenid = wx.getStorageSync('openid') || ''
    const isGuest = !!wx.getStorageSync('isGuest')
    if (!myOpenid || isGuest) {
      wx.setStorageSync('needLoginToast', '请先登录再编辑商品')
      wx.setStorageSync('pendingPage', { url: `/pages/market/marketPost/marketPost?id=${id}&mode=edit` })
      wx.navigateTo({ url: '/pages/other/login/login' })
      return
    }

    try {
      this.setData({ editLoading: true })
      const db = wx.cloud.database()
      const res = await db.collection('market_goods').doc(id).get()
      const x = res?.data || {}

      // 只能编辑自己发布的
      if (x._openid && x._openid !== myOpenid) {
        wx.showToast({ title: '只能编辑自己发布的商品', icon: 'none' })
        setTimeout(() => wx.navigateBack({ delta: 1 }), 600)
        return
      }

      const category = x.category || ''
      const categoryIndex = CATEGORY_OPTIONS.indexOf(category)
      const locationDisplayName = x.location?.displayName || x.region || ''

      // 图片：回填 fileIDs + 预览 temp urls
      const fileIds = Array.isArray(x.imageFileIDs) && x.imageFileIDs.length
        ? x.imageFileIDs.filter(Boolean)
        : (x.imageFileID ? [x.imageFileID] : [])

      let tempUrls = []
      if (fileIds.length) {
        const tmp = await wx.cloud.getTempFileURL({ fileList: fileIds })
        tempUrls = (tmp.fileList || []).map(z => z?.tempFileURL).filter(Boolean)
      }

      this.setData({
        title: x.title || '',
        desc: x.desc || '',
        category,
        categoryIndex: categoryIndex >= 0 ? categoryIndex : -1,
        price: (x.price === 0 || x.price) ? String(x.price) : '',
        condition: x.condition || '99新',
        region: x.region || '',
        locationInput: locationDisplayName,
        location: x.location || buildLocationMeta(x.region || ''),

        // 单图预览仍用 image
        image: tempUrls[0] || '',
        images: tempUrls,

        // 提交用 fileID
        imageFileID: x.imageFileID || (Array.isArray(x.imageFileIDs) ? (x.imageFileIDs[0] || '') : ''),
        imageFileIDs: Array.isArray(x.imageFileIDs) ? x.imageFileIDs : [],

        thumbFileID: x.thumbFileID || '',
        thumbFileIDs: Array.isArray(x.thumbFileIDs) ? x.thumbFileIDs : [],

        ...normalizePickupWindow(
          x.pickupStartDate || '',
          x.pickupEndDate || x.expiresAtText || ''
        )
      })
    } catch (e) {
      console.error(e)
      showDataError("商品加载失败", e, "商品详情从数据库加载失败，请稍后重试。")
    } finally {
      this.setData({ editLoading: false })
    }
  },

  // ========== 顶部返回 ==========
  onBack() {
    wx.navigateBack({ delta: 1 })
  },

  noop() {},

  onTapProfileLocation() {
    wx.navigateTo({ url: "/pages/profile/editInfo/editInfo?from=marketPost" })
  },

  async _getMyUserInfo() {
    try {
      const res = await wx.cloud.callFunction({ name: "getUserInfo" })
      return (res?.result?.data || [])[0] || {}
    } catch (e) {
      console.error("[marketPost] getUserInfo failed:", e)
      showDataError("资料加载失败", e, "个人资料从数据库加载失败，请稍后重试。")
      return null
    }
  },

  _promptEditProfile(title, content) {
    wx.showModal({
      title,
      content,
      confirmText: "去填写",
      cancelText: "取消",
      success: res => {
        if (res.confirm) this.onTapProfileLocation()
      }
    })
  },

  _applyProfileToForm(user = {}) {
    const profileWechatID = normalizeLocationText(user.wechatID)
    const displayName = buildProfileLocationDisplay(user || {})
    const updates = { profileWechatID }

    if (displayName && (!this._locationTouched || !this.data.locationInput)) {
      const location = buildLocationMeta(displayName, {
        ...(user.location || {}),
        source: user.location ? (user.location.source || "profile") : "profile"
      })
      Object.assign(updates, {
        region: displayName,
        locationInput: displayName,
        location
      })
    }

    this.setData(updates)
    return updates
  },

  // ========== 登录检查（发布前必须登录且非游客） ==========
  ensureLoginBeforePost() {
    const openid = wx.getStorageSync("openid") || ""
    const isGuest = !!wx.getStorageSync("isGuest")
    if (openid && !isGuest) return true

    wx.setStorageSync("needLoginToast", "请先登录再发布/编辑")
    wx.setStorageSync("pendingPage", {
      url: this.data.isEdit && this.data.editId
        ? `/pages/market/marketPost/marketPost?id=${this.data.editId}&mode=edit`
        : "/pages/market/marketPost/marketPost"
    })
    wx.navigateTo({ url: "/pages/other/login/login" })
    return false
  },

  _setImageUploadProgress(progress, text = "上传中") {
    const safeProgress = Math.max(0, Math.min(100, Math.round(progress)))
    const current = Number(this.data.imageUploadProgress) || 0
    const nextProgress = safeProgress < current && safeProgress < 100 ? current : safeProgress
    const now = Date.now()

    if (
      nextProgress < 100 &&
      now - (this._lastImageUploadProgressAt || 0) < 120 &&
      nextProgress - current < 3 &&
      text === this.data.imageUploadText
    ) {
      return
    }

    this._lastImageUploadProgressAt = now
    this.setData({
      imageUploadProgress: nextProgress,
      imageUploadProgressDeg: Math.round(nextProgress * 3.6),
      imageUploadText: text
    })
  },

  // ========== 选择图片（改为单图上传：其他提交流程不动） ==========
  async onChooseImage() {
    if (!this.ensureLoginBeforePost()) return
    if (this.data.imageUploading) {
      wx.showToast({ title: "图片上传中", icon: "none" })
      return
    }

    try {
      const res = await wx.chooseMedia({
        count: 1,
        mediaType: ["image"],
        sourceType: ["album", "camera"],
        sizeType: ["compressed"]
      })

      const tempFiles = (res.tempFiles || []).map(x => x.tempFilePath).filter(Boolean)
      if (!tempFiles.length) return

      const localPath = tempFiles[0]

      this.setData({
        image: localPath,
        images: [localPath],
        imageFileID: "",
        imageFileIDs: [],
        thumbFileID: "",
        thumbFileIDs: [],
        imageUploading: true,
        imageUploadProgress: 2,
        imageUploadProgressDeg: 7,
        imageUploadText: "压缩中"
      })

      const [mainUploadPath, thumbLocal] = await Promise.all([
        prepareMainImageForUpload(this, localPath),
        genThumbFromFirstImage(this, localPath)
      ])

      this._setImageUploadProgress(18, "上传中")

      let mainProgress = 0
      let thumbProgress = thumbLocal ? 0 : 100
      const updateUploadProgress = () => {
        const weighted = 18 + mainProgress * 0.72 + thumbProgress * 0.10
        this._setImageUploadProgress(Math.min(98, weighted), "上传中")
      }

      const thumbUploadPromise = thumbLocal
        ? compressForUpload(thumbLocal, MARKET_THUMB_IMAGE_QUALITY)
          .then(path => {
            thumbProgress = 18
            updateUploadProgress()
            return uploadOne(path, "market_thumb", progress => {
              thumbProgress = progress
              updateUploadProgress()
            })
          })
        : Promise.resolve("")

      const [fileID, thumbFID] = await Promise.all([
        uploadOne(mainUploadPath, "market", progress => {
          mainProgress = progress
          updateUploadProgress()
        }),
        thumbUploadPromise
      ])

      if (!fileID) {
        wx.showToast({ title: "上传失败", icon: "none" })
        this.setData({ imageUploading: false })
        return
      }

      this._setImageUploadProgress(100, "已完成")
      this.setData({
        imageFileID: fileID,
        imageFileIDs: [fileID],
        thumbFileID: thumbFID || "",
        thumbFileIDs: thumbFID ? [thumbFID] : []
      })

      registerUploadedMarketFiles([
        { fileID, type: "image", folder: "market" },
        thumbFID ? { fileID: thumbFID, type: "thumb", folder: "market_thumb" } : null
      ]).catch(() => {})

      wx.showToast({ title: "上传成功", icon: "success" })
      setTimeout(() => {
        if (this.data.imageFileID === fileID) {
          this.setData({ imageUploading: false })
        }
      }, 450)
    } catch (e) {
      console.error(e)
      wx.showToast({ title: "选择/上传失败", icon: "none" })
      this.setData({ imageUploading: false })
    }
  },

  // ========== 输入 ==========
  onTitleInput(e) {
    this.setData({ title: e.detail.value || "" })
  },
  onDescInput(e) {
    this.setData({ desc: e.detail.value || "" })
  },
  onPriceInput(e) {
    this.setData({ price: e.detail.value || "" })
  },

  onPickupStartDateChange(e) {
    const start = e.detail.value || this.data.pickupStartDate
    this.setData(normalizePickupWindow(start, this.data.pickupEndDate))
  },

  onPickupEndDateChange(e) {
    const end = e.detail.value || this.data.pickupEndDate
    this.setData(normalizePickupWindow(this.data.pickupStartDate, end))
  },

  onTapPhrase(e) {
    const t = e.currentTarget.dataset.text || ""
    const old = this.data.desc || ""
    const next = old ? `${old}\n${t}` : t
    this.setData({ desc: next })
  },

  // ========== 分类 picker ==========
  onCategoryPickerChange(e) {
    const idx = Number(e.detail.value)
    const category = CATEGORY_OPTIONS[idx] || ""
    this.setData({ categoryIndex: idx, category })
  },

  // ========== 新旧程度 ==========
onChooseCondition() {
  wx.showActionSheet({
    itemList: this.data.conditionOptions || [],
    success: (res) => {
      const idx = res.tapIndex
      const val = (this.data.conditionOptions || [])[idx]
      if (val) this.setData({ condition: val })
    }
  })
},


  // ========== 提交：发布 / 编辑 ==========
  async onSubmit() {
    if (!this.ensureLoginBeforePost()) return
    if (this.data.submitting) return

    const {
      imageFileID,
      title,
      desc,
      category,
      price,
      condition,
      pickupStartDate,
      pickupEndDate
    } = this.data
    const imageFileIDs = uniqFileIDs([imageFileID, ...(Array.isArray(this.data.imageFileIDs) ? this.data.imageFileIDs : [])])
    const thumbFileIDs = uniqFileIDs([this.data.thumbFileID, ...(Array.isArray(this.data.thumbFileIDs) ? this.data.thumbFileIDs : [])])
    const pickupWindow = normalizePickupWindow(pickupStartDate, pickupEndDate)
    const expireTime = endOfDayTime(pickupWindow.pickupEndDate)
    const hasImage = imageFileIDs.length > 0

    if (this.data.imageUploading) {
      return wx.showToast({ title: "图片还在上传中", icon: "none" })
    }
    if (!title.trim()) return wx.showToast({ title: "请输入标题", icon: "none" })
    if (!category) return wx.showToast({ title: "请选择分类", icon: "none" })

    const profile = await this._getMyUserInfo()
    if (!profile) return
    const profileUpdates = this.data.isEdit
      ? { profileWechatID: normalizeLocationText(profile.wechatID) }
      : this._applyProfileToForm(profile)
    if (this.data.isEdit) this.setData(profileUpdates)
    if (!normalizeLocationText(profile.wechatID)) {
      this._promptEditProfile("请先填写微信号", "发布闲置前需要在个人资料里填写微信号，方便买家联系。")
      return
    }

    const region = normalizeLocationText(profileUpdates.locationInput || this.data.locationInput || this.data.region)
    const location = buildLocationMeta(region, profileUpdates.location || this.data.location || {})
    if (!region) return wx.showToast({ title: "请选择地区", icon: "none" })
    if (!expireTime) return wx.showToast({ title: "请选择可取时间", icon: "none" })

    this.setData({ submitting: true })

    try {
      const payload = {
        title: String(title).trim(),
        price: Number(price || 0),
        category,
        region,
        location,
        condition: condition || "99新",
        desc: desc || "",
        imageFileID: imageFileIDs[0] || "",
        imageFileIDs,
        thumbFileID: thumbFileIDs[0] || "",
        thumbFileIDs,
        hasImage,
        pickupStartDate: pickupWindow.pickupStartDate,
        pickupEndDate: pickupWindow.pickupEndDate,
        pickupRangeText: pickupWindow.pickupRangeText,
        expireTime,
        expiresAtText: pickupWindow.pickupEndDate,
        status: "online"
      }

      if (this.data.isEdit && this.data.editId) {
        const updRes = await wx.cloud.callFunction({
          name: "updateMarketItem",
          data: { id: this.data.editId, patch: payload }
        })

        const ur = updRes?.result || {}
        if (!ur.ok) {
          wx.showToast({ title: ur.error || "保存失败", icon: "none" })
          return
        }

        wx.showToast({ title: "已保存", icon: "success" })
        setTimeout(() => wx.navigateBack({ delta: 1 }), 900)
        return
      }

      const checkRes = await wx.cloud.callFunction({
        name: "createMarketItem",
        data: payload
      })

      const r = checkRes?.result || {}
      if (r.ok === false) {
        wx.showToast({ title: r.message || "发布失败", icon: "none" })
        return
      }

      const createdId = r.itemId || r.id || r.docId || r._id || ""
      if (createdId && hasImage) {
        registerUploadedMarketFiles([
          ...imageFileIDs.map(fileID => ({ fileID, type: "image", folder: "market" })),
          ...thumbFileIDs.map(fileID => ({ fileID, type: "thumb", folder: "market_thumb" }))
        ], createdId).catch(() => {})
      }

      wx.showToast({ title: this.data.isEdit ? "已保存" : "已提交", icon: "success" })
      setTimeout(() => wx.navigateBack({ delta: 1 }), 900)
    } catch (e) {
      console.error(e)
      showDataError("发布失败", e, "商品保存到数据库失败，请稍后重试。")
    } finally {
      this.setData({ submitting: false })
    }
  }
})
