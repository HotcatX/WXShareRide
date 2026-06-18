const defaultAvatarUrl = 'https://mmbiz.qpic.cn/mmbiz/icTdbqWNOwNRna42FI242Lcia07jQodd2FJGIYQfG0LAJGFxM4FbnQP6yfMxBgJ0F3YRqJCJ1aPAK2dQagdusBZg/0'

// ====================== ✅ 所住区域 bigregion：云端 regionTree 优先 ======================
// - 云端集合：regionTree
// - 优先 doc("default")，否则取第一条
// - 字段：tree（结构：[{label, children:[{label, children:[...]}]}]）
// - 失败回退本地
const LOCAL_REGION_TREE = [
  {
    label: "无",
    children: [
      { label: "无", children: ["无"] }
    ]
  },
  {
    label: "NJ",
    children: [
      { label: "FL", children: ["Modern", "Fiat House"] },
      { label: "JC", children: ["Newport", "Journal Sq", "Exchange Place"] }
    ]
  },
  {
    label: "NY",
    children: [
      { label: "上城", children: ["Inwood", "125St", "哥大步行楼", "96St"] },
      { label: "中城", children: ["Times Sq", "42St", "34St"] },
      { label: "下城", children: ["SoHo", "Chinatown", "Wall St"] },
      { label: "LIC", children: ["Court Sq", "Hunters Point", "Queens Plaza"] }
    ]
  }
]

// REGION_TREE 改成可变：云端拉到后覆盖
let REGION_TREE = LOCAL_REGION_TREE

const REGION_TREE_CACHE_KEY = "region_tree_cache_v1"
const REGION_TREE_CACHE_AT_KEY = "region_tree_cache_at_v1"
const REGION_TREE_CACHE_TTL_MS = 12 * 60 * 60 * 1000 // 12h

function normalizeRegionTree(raw) {
  let tree = raw
  if (tree && Array.isArray(tree.tree)) tree = tree.tree
  if (!Array.isArray(tree)) return LOCAL_REGION_TREE

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

  if (!out.length) return LOCAL_REGION_TREE

  // 确保“无/无/无”在最前面（避免你原 UI 行为变化）
  const hasNone = out[0] && out[0].label === "无"
  return hasNone ? out : [LOCAL_REGION_TREE[0], ...out]
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
    return LOCAL_REGION_TREE
  }
}

function safeArr(arr) {
  return Array.isArray(arr) && arr.length ? arr : ["—"]
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
    // 新增：住址（选填）
    address: '',

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

    // 先用本地初始化列（避免空白）
    const { col1, col2, col3 } = buildCols(0, 0)
    this.setData({
      bigRegionCol1: col1,
      bigRegionCol2: col2,
      bigRegionCol3: col3
    })

    // ✅ 只改这里：云端拉取 regionTree 覆盖 REGION_TREE
    this._loadRegionTree()

    // 拉取云端 userInfo
    this.loadUserInfo()
  },

  async _loadRegionTree() {
    const tree = await getRegionTreeFromCloud()
    REGION_TREE = (tree && tree.length) ? tree : LOCAL_REGION_TREE

    const [v0, v1] = this.data.bigRegionPickerValue || [0, 0]
    const { col1, col2, col3 } = buildCols(v0, v1)

    this.setData({
      bigRegionCol1: col1,
      bigRegionCol2: col2,
      bigRegionCol3: col3
    })
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
    }
  },

  onInput(e) {
    const { field } = e.currentTarget.dataset
    this.setData({ [field]: e.detail.value, unsaved: true })
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

  // ✅ 保留你原来的保存入口：onComplete（wxml 绑的就是它）
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
      wx.showToast({ title: '网络错误，请稍后再试', icon: 'none' })
      return false
    }
  }
})
