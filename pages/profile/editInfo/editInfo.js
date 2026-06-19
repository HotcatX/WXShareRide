const defaultAvatarUrl = 'https://mmbiz.qpic.cn/mmbiz/icTdbqWNOwNRna42FI242Lcia07jQodd2FJGIYQfG0LAJGFxM4FbnQP6yfMxBgJ0F3YRqJCJ1aPAK2dQagdusBZg/0'
const { showDataError } = require('../../../utils/error')

// ====================== ✅ 所住区域 bigregion：云端 regionTree 优先 ======================
// - 云端集合：regionTree
// - 优先 doc("default")，否则取第一条
// - 字段：tree（结构：[{label, children:[{label, children:[...]}]}]）
const NONE_REGION_NODE = { label: "无", children: [{ label: "无", children: ["无"] }] }

// REGION_TREE 改成可变：云端拉到后覆盖
let REGION_TREE = [NONE_REGION_NODE]

const REGION_TREE_CACHE_KEY = "region_tree_cache_v1"
const REGION_TREE_CACHE_AT_KEY = "region_tree_cache_at_v1"
const REGION_TREE_CACHE_TTL_MS = 12 * 60 * 60 * 1000 // 12h

function normalizeRegionTree(raw) {
  let tree = raw
  if (tree && Array.isArray(tree.tree)) tree = tree.tree
  if (!Array.isArray(tree)) throw new Error("regionTree 数据格式错误")

  const out = tree
    .map(x => ({
      label: (x && (x.label || x.name)) || "",
      children: Array.isArray(x?.children) ? x.children : []
    }))
    .filter(x => x.label)
    .map(x => ({
      label: x.label,
      children: (x.children || [])
        .map(y => ({
          label: (y && (y.label || y.name)) || "",
          children: Array.isArray(y?.children) ? y.children.filter(Boolean) : []
        }))
        .filter(y => y.label)
    }))

  if (!out.length) throw new Error("regionTree 为空")

  // 确保“无/无/无”在最前面（避免你原 UI 行为变化）
  const hasNone = out[0] && out[0].label === "无"
  return hasNone ? out : [NONE_REGION_NODE, ...out]
}

async function getRegionTreeFromCloud() {
  // 先走缓存
  try {
    const cache = wx.getStorageSync(REGION_TREE_CACHE_KEY)
    const at = Number(wx.getStorageSync(REGION_TREE_CACHE_AT_KEY) || 0)
    if (cache && Date.now() - at < REGION_TREE_CACHE_TTL_MS) {
      return normalizeRegionTree(cache)
    }
  } catch (e) {}

  // 再拉云端
  try {
    const db = wx.cloud.database()
    let docData = null

    try {
      const doc = await db.collection("regionTree").doc("default").get()
      docData = doc?.data || null
    } catch (e) {}

    if (!docData) {
      const res = await db.collection("regionTree").limit(1).get()
      docData = (res.data || [])[0] || null
    }

    const tree = normalizeRegionTree(docData)

    // 写缓存
    try {
      wx.setStorageSync(REGION_TREE_CACHE_KEY, tree)
      wx.setStorageSync(REGION_TREE_CACHE_AT_KEY, Date.now())
    } catch (e) {}

    return tree
  } catch (e) {
    throw e
  }
}

function safeArr(arr) {
  return Array.isArray(arr) && arr.length ? arr : ["—"]
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function buildLocationFromChooseResult(res = {}) {
  const lat = Number(res.latitude)
  const lng = Number(res.longitude)
  const displayName = normalizeText(res.name || res.address)

  return {
    displayName,
    name: normalizeText(res.name || displayName),
    address: normalizeText(res.address || displayName),
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    source: 'chooseLocation',
    updatedAtMs: Date.now()
  }
}

function getLocationDisplay(location = {}, address = '') {
  return normalizeText(
    location.displayName ||
    location.name ||
    location.address ||
    address
  )
}

function buildCols(v0, v1) {
  const col1 = REGION_TREE.map(x => x.label)

  const lv1 = REGION_TREE[v0] || REGION_TREE[0]
  const col2 = safeArr((lv1.children || []).map(x => x.label))

  const lv2 = (lv1.children || [])[v1] || (lv1.children || [])[0] || { children: ["—"] }
  const col3 = safeArr(lv2.children)

  return { col1, col2, col3 }
}

Page({
  data: {
    from: 'profile',

    // 原来 wechat1 / wechat2 合并为一个字段
    wechat: '',
    address: '',
    location: {},
    locationDisplay: '',

    // ✅ 所住区域（存到 userInfo.bigregion）
    bigregion: '',

    phone: '',
    regionIndex: 0,
    regions: ['美国', '中国大陆'],
    statusBarHeight: 80,
    pageTitle: '编辑个人信息',

    name: '',
    avatarUrl: defaultAvatarUrl,
    zelleName: '',
    zelleAccount: '',

    // 车辆信息
    carNumber: '',
    carBrand: '',
    carModel: '',

    // 自定义价格（选填）
    customPriceNonCore: '',
    customPriceCore: '',

    unsaved: false,

    // ====== bigregion 三列滑动选择器 ======
    bigRegionPickerVisible: false,
    bigRegionPickerValue: [0, 0, 0],
    bigRegionCol1: [],
    bigRegionCol2: [],
    bigRegionCol3: []
  },

  goBack() {
    wx.navigateBack()
  },

  onLoad(options) {
    const info = wx.getSystemInfoSync()
    this.setData({
      statusBarHeight: info.statusBarHeight
    })

    const from = options.from || 'profile'
    this.setData({ from })

    this.setData({
      bigRegionCol1: ["加载中"],
      bigRegionCol2: ["加载中"],
      bigRegionCol3: ["加载中"]
    })

    this._loadRegionTree()

    // 拉取云端 userInfo
    this.loadUserInfo()
  },

  async _loadRegionTree() {
    try {
      const tree = await getRegionTreeFromCloud()
      REGION_TREE = tree

      const [v0, v1] = this.data.bigRegionPickerValue || [0, 0]
      const { col1, col2, col3 } = buildCols(v0, v1)

      this.setData({
        bigRegionCol1: col1,
        bigRegionCol2: col2,
        bigRegionCol3: col3
      })
    } catch (e) {
      console.error("regionTree 加载失败：", e)
      showDataError("地区加载失败", e, "地区配置从数据库加载失败，请稍后重试。")
      this.setData({
        bigRegionCol1: ["加载失败"],
        bigRegionCol2: ["加载失败"],
        bigRegionCol3: ["加载失败"]
      })
    }
  },

  // 上传头像
  async onChooseAvatar(e) {
    const { avatarUrl } = e.detail || {}
    if (!avatarUrl) return


    try {
      const extMatch = avatarUrl.match(/\.(\w+)$/)
      const ext = extMatch ? extMatch[1] : 'jpg'
      const cloudPath = `userAvatar/${Date.now()}-${Math.floor(Math.random() * 1000000)}.${ext}`

      const uploadRes = await wx.cloud.uploadFile({
        cloudPath,
        filePath: avatarUrl
      })

      this.setData({
        avatarUrl: uploadRes.fileID,
        unsaved: true
      })
    } catch (err) {
      console.error('上传头像失败：', err)
      wx.showToast({ title: '头像上传失败，请重试', icon: 'none' })
    } finally {
    }
  },

  // 拉取云端现有 userInfo
  async loadUserInfo() {
    try {
      const res = await wx.cloud.callFunction({ name: 'getUserInfo' })
      if (res.result && res.result.data && res.result.data.length > 0) {
        const user = res.result.data[0]
        const cp = user.customPrice || {}

        this.setData({
          wechat: user.wechatID || '',
          address: user.address || '',
          location: user.location || {},
          locationDisplay: getLocationDisplay(user.location || {}, user.address || ''),
          bigregion: user.bigregion || '',

          phone: user.phone || '',
          regionIndex: (user.region === 'CN') ? 1 : 0,
          name: user.name || '',
          avatarUrl: user.avatarUrl || this.data.avatarUrl,
          zelleName: user.zelleName || '',
          zelleAccount: user.zelleAccount || '',
          carNumber: user.carNumber || '',
          carBrand: user.carBrand || '',
          carModel: user.carModel || '',
          customPriceNonCore: cp.fortLeeNonCore || '',
          customPriceCore: cp.fortLeeCore || ''
        })
      }
    } catch (e) {
      console.error('loadUserInfo 失败：', e)
      showDataError('资料加载失败', e, '个人资料从数据库加载失败，请稍后重试。')
    }
  },

  onInput(e) {
    const { field } = e.currentTarget.dataset
    const value = e.detail.value
    if (field === 'address') {
      this.setData({
        address: value,
        location: {},
        locationDisplay: normalizeText(value),
        unsaved: true
      })
      return
    }
    this.setData({ [field]: value, unsaved: true })
  },

  async onChooseLocation() {
    try {
      const res = await wx.chooseLocation({})
      if (!res) return

      const location = buildLocationFromChooseResult(res)
      const display = getLocationDisplay(location)
      if (!display) return

      this.setData({
        address: display,
        location,
        locationDisplay: display,
        unsaved: true
      })
    } catch (e) {
    }
  },

  onRegionChange(e) {
    this.setData({ regionIndex: e.detail.value, unsaved: true })
  },

  // ====== bigregion：打开三列滚动选择器 ======
  onChooseBigRegion() {
    const [v0, v1] = this.data.bigRegionPickerValue || [0, 0]
    const { col1, col2, col3 } = buildCols(v0, v1)
    this.setData({
      bigRegionPickerVisible: true,
      bigRegionCol1: col1,
      bigRegionCol2: col2,
      bigRegionCol3: col3
    })
  },

  onBigRegionPickerChange(e) {
    const newVal = e.detail.value || [0, 0, 0]
    const oldVal = this.data.bigRegionPickerValue || [0, 0, 0]

    let [v0, v1, v2] = newVal

    if (v0 !== oldVal[0]) {
      v1 = 0
      v2 = 0
    } else if (v1 !== oldVal[1]) {
      v2 = 0
    }

    const { col2, col3 } = buildCols(v0, v1)

    this.setData({
      bigRegionPickerValue: [v0, v1, v2],
      bigRegionCol2: col2,
      bigRegionCol3: col3
    })
  },

  onBigRegionPickerCancel() {
    this.setData({ bigRegionPickerVisible: false })
  },

  onBigRegionPickerConfirm() {
    const [v0, v1, v2] = this.data.bigRegionPickerValue || [0, 0, 0]

    const lv1 = REGION_TREE[v0] || REGION_TREE[0]
    const lv2 = (lv1.children || [])[v1] || (lv1.children || [])[0]
    const lv3 = safeArr(lv2?.children)[v2] || safeArr(lv2?.children)[0]

    const bigregion = `${lv1.label} / ${lv2.label} / ${lv3}`

    this.setData({
      bigregion,
      bigRegionPickerVisible: false,
      unsaved: true
    })
  },

  // 手机号选填；微信号必填
  validateAll() {
    const { wechat, phone, regionIndex } = this.data

    if (!wechat) return '请填写微信号'

    if (phone) {
      if (regionIndex == 0 && !/^\d{10}$/.test(phone)) return '请输入正确美国手机号'
      if (regionIndex == 1 && !/^1\d{10}$/.test(phone)) return '请输入正确大陆手机号'
    }

    return ''
  },

  async onComplete() {
    const msg = this.validateAll()
    if (msg) {
      wx.showToast({ title: msg, icon: 'none', duration: 2000 })
      return
    }

    const ok = await this.saveToCloud()
    if (!ok) {
      wx.showToast({ title: '信息保存失败，请稍后重试', icon: 'none' })
      return
    }

    wx.showToast({ title: '信息已更新', icon: 'success' })
    wx.navigateBack()
  },

  async saveToCloud() {
    const {
      wechat,
      address,
      location,
      bigregion,
      phone,
      regionIndex,
      customPriceNonCore,
      customPriceCore
    } = this.data

    const region = regionIndex == 0 ? 'US' : 'CN'
    const updateData = {}

    if (wechat) {
      updateData.wechatID = wechat
    }

    if (phone) {
      const cnValid = region === 'CN' && /^1\d{10}$/.test(phone)
      const usValid = region === 'US' && /^\d{10}$/.test(phone)
      if (cnValid || usValid) {
        updateData.phone = phone
        updateData.region = region
      }
    }

    updateData.address = address || ''
    if (location && typeof location === 'object' && (location.displayName || location.address || location.lat || location.lng)) {
      updateData.location = location
    }
    updateData.bigregion = bigregion || ''

    updateData.name = this.data.name || ''
    updateData.avatarUrl = this.data.avatarUrl || ''
    updateData.zelleName = this.data.zelleName || ''
    updateData.zelleAccount = this.data.zelleAccount || ''

    updateData.carNumber = this.data.carNumber || ''
    updateData.carBrand = this.data.carBrand || ''
    updateData.carModel = this.data.carModel || ''

    if (customPriceNonCore || customPriceCore) {
      updateData.customPrice = {
        fortLeeNonCore: customPriceNonCore || '',
        fortLeeCore: customPriceCore || ''
      }
    }

    if (Object.keys(updateData).length === 0) {
      wx.showToast({ title: '请先填写正确信息', icon: 'none' })
      return false
    }

    try {
      const res = await wx.cloud.callFunction({
        name: 'updateUser',
        data: updateData
      })
      const result = res.result || {}
      if (!result.ok) {
        wx.showToast({ title: result.errorMsg || '保存失败', icon: 'none' })
        return false
      }

      this.setData({ unsaved: false })
      return true
    } catch (e) {
      console.error('updateUser 调用失败', e)
      showDataError('保存失败', e, '个人资料保存到数据库失败，请稍后重试。')
      return false
    }
  }
})
