// pages/market/marketMy/marketMy.js
const { showDataError } = require("../../../utils/error")
const {
  buildProfileDisplayLocation,
  buildProfileApartmentDisplay
} = require("../../../utils/profileDisplay")
const MARKET_REFRESH_KEY = "market_goods_changed_at"
const LISTING_TYPE_STORAGE_KEY = "market_active_listing_type_v1"
const defaultAvatarUrl =
  'https://mmbiz.qpic.cn/mmbiz/icTdbqWNOwNRna42FI242Lcia07jQodd2FJGIYQfG0LAJGFxM4FbnQP6yfMxBgJ0F3YRqJCJ1aPAK2dQagdusBZg/0'
const LISTING_TYPE_CONFIG = {
  goods: {
    label: "二手",
    navTitle: "我的市场",
    sectionTitle: "我发布的商品",
    emptyTitle: "还没有发布商品",
    emptySubtitle: "发布第一件闲置，让附近同学看到",
    manageText: "管理我的商品",
    deleteConfirmName: "商品",
    shareTitle: "二手商品",
    shareRole: "卖家",
    fallbackTitle: "未命名商品",
    fallbackImage: "/images/market.png",
    metaFallback: "闲置"
  },
  sublet: {
    label: "转租",
    navTitle: "我的市场",
    sectionTitle: "我发布的转租",
    emptyTitle: "还没有发布转租",
    emptySubtitle: "发布第一套房源，让附近同学看到",
    manageText: "管理我的转租",
    deleteConfirmName: "房源",
    shareTitle: "转租房源",
    shareRole: "发布者",
    fallbackTitle: "未命名房源",
    fallbackImage: "/images/sublease.png",
    metaFallback: "转租"
  }
}

function normalizeListingType(value) {
  return String(value || "").toLowerCase() === "sublet" ? "sublet" : "goods"
}

function getStoredListingType() {
  try {
    return normalizeListingType(wx.getStorageSync(LISTING_TYPE_STORAGE_KEY))
  } catch (e) {
    return "goods"
  }
}

function setStoredListingType(type) {
  try {
    wx.setStorageSync(LISTING_TYPE_STORAGE_KEY, normalizeListingType(type))
  } catch (e) {}
}

function getListingTypeConfig(type) {
  return LISTING_TYPE_CONFIG[normalizeListingType(type)] || LISTING_TYPE_CONFIG.goods
}

function buildListingTypeTabs(activeType) {
  return ["goods", "sublet"].map(type => ({
    type,
    label: LISTING_TYPE_CONFIG[type].label,
    selectedClass: normalizeListingType(activeType) === type ? "selected" : ""
  }))
}

function getMarketGoodsChangedAt() {
  try {
    return Number(wx.getStorageSync(MARKET_REFRESH_KEY)) || 0
  } catch (e) {
    return 0
  }
}

function markMarketGoodsChanged() {
  try {
    wx.setStorageSync(MARKET_REFRESH_KEY, Date.now())
  } catch (e) {}
}

function getMarketApiResult(res) {
  const result = res && res.result
  if (!result || result.ok === false) {
    throw new Error((result && (result.error || result.message)) || "market_api_failed")
  }
  return result
}

function formatMarketPrice(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n.toFixed(n % 1 === 0 ? 0 : 2) : '0'
}

function buildMyGoodsItem(x = {}) {
  const listingType = normalizeListingType(x.listingType)
  const config = getListingTypeConfig(listingType)
  const title = String(x.title || '').trim() || config.fallbackTitle
  const imageKey = x.thumbFileID || x.imageFileID || ''
  const priceText = formatMarketPrice(x.price)
  const metaText = listingType === "sublet"
    ? (x.leaseText || x.availableStartDate || x.roomType || x.category || config.metaFallback)
    : (x.condition || x.pickupEndDate || config.metaFallback)
  return {
    id: x._id || x.id || '',
    listingType,
    title,
    price: x.price,
    priceText,
    priceDisplay: listingType === "sublet" ? `${priceText}/月` : priceText,
    metaText,
    typeTagText: config.label,
    imageFileID: x.imageFileID || '',
    imageFileIDs: Array.isArray(x.imageFileIDs) ? x.imageFileIDs : [],
    thumbFileID: x.thumbFileID || '',
    thumbFileIDs: Array.isArray(x.thumbFileIDs) ? x.thumbFileIDs : [],
    hasImage: !!(x.hasImage || x.imageFileID || x.thumbFileID || (Array.isArray(x.imageFileIDs) && x.imageFileIDs.length)),
    imageSrc: x.imageSrc || x.thumbUrl || imageKey || config.fallbackImage,
    pickupEndDate: x.pickupEndDate || x.expiresAtText || '',
    expireTime: Number(x.expireTime) || 0,
    status: x.status || 'online',
    thumbUrl: x.thumbUrl || ''
  }
}

function withSelectionState(goods = [], selectedMap = {}) {
  return goods.map(g => {
    const selected = !!selectedMap[g.id]
    return {
      ...g,
      selected,
      selectedClass: selected ? 'on' : ''
    }
  })
}

function stripSelectionState(goods = []) {
  return (Array.isArray(goods) ? goods : []).map(g => {
    const copy = { ...(g || {}) }
    delete copy.selected
    delete copy.selectedClass
    return copy
  })
}

function buildMyDisplayPatch(state = {}) {
  const goods = Array.isArray(state.goods) ? state.goods : []
  const selectedCount = Number(state.selectedCount) || 0
  const activeListingType = normalizeListingType(state.activeListingType)
  const config = getListingTypeConfig(activeListingType)
  return {
    navTitle: config.navTitle,
    nameDisplay: state.name || '未设置昵称',
    wechatStatusText: state.wechatID ? '微信已填写' : '未填写微信',
    regionDisplay: state.region || '所住公寓未填',
    apartmentDisplay: state.apartment || '',
    saveStateText: state.isSavingBio ? '保存中' : '自动保存',
    hasGoods: goods.length > 0,
    goodsEmpty: goods.length === 0,
    goodsTitleMain: config.sectionTitle,
    goodsEmptyTitle: config.emptyTitle,
    goodsEmptySubtitle: config.emptySubtitle,
    manageButtonText: config.manageText,
    listingTypeTabs: buildListingTypeTabs(activeListingType),
    allSelectedText: state.allSelected ? '取消全选' : '全选',
    deleteDisabledClass: selectedCount > 0 ? '' : 'disabled'
  }
}

Page({
  data: {
    statusBarHeight: 0,

    avatarUrl: defaultAvatarUrl,
    name: '',
    wechatID: '',
    region: '',
    apartment: '',
    bio: '',

    bioOriginal: '',
    isSavingBio: false,

	    openid: '',
    activeListingType: 'goods',
    listingTypeTabs: buildListingTypeTabs('goods'),
    goods: [],

    // ✅ 管理模式 = 多选模式
    manageMode: false,

    // ✅ 多选状态
    selectedMap: {},   // { [id]: true }
    selectedCount: 0,
    allSelected: false,
    nameDisplay: '未设置昵称',
    wechatStatusText: '未填写微信',
    regionDisplay: '地址未填',
    apartmentDisplay: '公寓未填',
    saveStateText: '自动保存',
    hasGoods: false,
    goodsEmpty: true,
    allSelectedText: '全选',
    navTitle: '我的市场',
    goodsTitleMain: '我发布的商品',
    goodsEmptyTitle: '还没有发布商品',
    goodsEmptySubtitle: '发布第一件闲置，让附近同学看到',
    manageButtonText: '管理我的商品',
    deleteDisabledClass: 'disabled',
    dockVisibleClass: 'dock-hidden'
  },

  onReady() {
    setTimeout(() => {
      this._setMyData({ dockVisibleClass: '' })
    }, 320)
  },

  _setMyData(patch = {}) {
    const nextState = { ...this.data, ...patch }
    const selectedMap = nextState.selectedMap || {}
    let patchToSet = { ...patch }
    let goodsForDisplay = nextState.goods

    if (Object.prototype.hasOwnProperty.call(patch, 'goods') ||
      Object.prototype.hasOwnProperty.call(patch, 'selectedMap') ||
      Object.prototype.hasOwnProperty.call(patch, 'selectedCount') ||
      Object.prototype.hasOwnProperty.call(patch, 'allSelected')) {
      goodsForDisplay = withSelectionState(Array.isArray(nextState.goods) ? nextState.goods : [], selectedMap)
      patchToSet.goods = goodsForDisplay
    }

    this.setData({
      ...patchToSet,
      ...buildMyDisplayPatch({ ...nextState, goods: goodsForDisplay })
    })
  },

  onLoad(options) {
    const sys = typeof wx.getWindowInfo === "function" ? wx.getWindowInfo() : wx.getSystemInfoSync()
    const activeListingType = normalizeListingType(options?.type || options?.listingType || getStoredListingType())
    setStoredListingType(activeListingType)
    this._setMyData({ statusBarHeight: sys.statusBarHeight || 0, activeListingType })

    wx.showShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] })
    this._lastHandledGoodsChangeAt = getMarketGoodsChangedAt()

    this.loadUserInfo().then(() => {
      this.fetchMyGoods()
    })
  },

  onShow() {
    const changedAt = getMarketGoodsChangedAt()
    if (!changedAt || changedAt === this._lastHandledGoodsChangeAt) return
    this._lastHandledGoodsChangeAt = changedAt
    this._clearMyGoodsCache()
    this.loadUserInfo().then(() => {
      this.fetchMyGoods({ force: true })
    })
  },

  onShareAppMessage() {
    const openid = this.data.openid || ''
    const config = getListingTypeConfig(this.data.activeListingType)
    const title = this.data.name ? `看看 ${this.data.name} 的${config.shareTitle}` : `查看${config.shareRole}${config.shareTitle}`
    return getApp().withReferralShare({ title, path: `/pages/market/marketSeller/marketSeller?openid=${encodeURIComponent(openid)}&type=${this.data.activeListingType || "goods"}` })
  },

  onShareTimeline() {
    const openid = this.data.openid || ''
    const config = getListingTypeConfig(this.data.activeListingType)
    const title = this.data.name ? `看看 ${this.data.name} 的${config.shareTitle}` : `查看${config.shareRole}${config.shareTitle}`
    return getApp().withReferralShare({ title, query: `openid=${encodeURIComponent(openid)}&type=${this.data.activeListingType || "goods"}` })
  },

  onPullDownRefresh() {
    Promise.resolve()
      .then(() => this.loadUserInfo())
      .then(() => this.fetchMyGoods({ force: true }))
      .finally(() => wx.stopPullDownRefresh())
  },

  onBack() {
    const pages = getCurrentPages()
    if (pages.length > 1) {
      wx.navigateBack({ delta: 1 })
      return
    }

    // 栈里只有当前页：说明是分享/收藏/redirect 进来的，必须回 tab
    wx.reLaunch({
      url: '/pages/market/market'   // ← 改成你的“主页面/拼车所在 tab 页”
    })
  },

  onAddGood() {
    wx.navigateTo({ url: `/pages/market/marketPost/marketPost?type=${this.data.activeListingType || "goods"}` })
  },

  onSelectListingType(e) {
    const type = normalizeListingType(e.currentTarget.dataset.type)
    if (type === this.data.activeListingType) return
    setStoredListingType(type)
    const cached = this._getFreshMyGoodsCache(type)
    this._setMyData({
      activeListingType: type,
      goods: cached ? cached.goods : [],
      selectedMap: {},
      selectedCount: 0,
      allSelected: false,
      manageMode: false
    })
    this.fetchMyGoods()
  },

  // ✅ 进入/退出多选管理
  onToggleManage() {
    const next = !this.data.manageMode
    this._setMyData({
      manageMode: next,
      selectedMap: {},
      selectedCount: 0,
      allSelected: false
    })
  },

  // ✅ 点击商品卡片：
  // - 管理模式：勾选/取消勾选
  // - 非管理：打开详情
  onOpenGood(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return

    if (this.data.manageMode) {
      this._toggleSelectById(id)
      return
    }

    wx.navigateTo({ url: `/pages/market/marketDetail/marketDetail?id=${id}` })
  },

  // ✅ 点勾选框（防止冒泡）
  onToggleSelect(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    this._toggleSelectById(id)
  },

  _toggleSelectById(id) {
    const map = { ...(this.data.selectedMap || {}) }
    map[id] = !map[id]
    if (!map[id]) delete map[id]

    const selectedCount = Object.keys(map).length
    const allSelected = (this.data.goods?.length || 0) > 0 && selectedCount === (this.data.goods?.length || 0)

    this._setMyData({ selectedMap: map, selectedCount, allSelected })
  },

  // ✅ 全选/取消全选
  onToggleSelectAll() {
    const goods = this.data.goods || []
    if (!goods.length) return

    if (this.data.allSelected) {
      this._setMyData({ selectedMap: {}, selectedCount: 0, allSelected: false })
      return
    }

    const map = {}
    goods.forEach(g => { if (g?.id) map[g.id] = true })
    this._setMyData({ selectedMap: map, selectedCount: goods.length, allSelected: true })
  },

  // ✅ 批量删除
  async onDeleteSelected() {
    const ids = Object.keys(this.data.selectedMap || {})
    if (!ids.length) {
      wx.showToast({ title: `请先选择要删除的${getListingTypeConfig(this.data.activeListingType).deleteConfirmName}`, icon: 'none' })
      return
    }

    const confirm = await new Promise((resolve) => {
      wx.showModal({
        title: `确认删除 ${ids.length} 个${getListingTypeConfig(this.data.activeListingType).deleteConfirmName}？`,
        content: '删除后无法恢复',
        confirmText: '删除',
        confirmColor: '#d9644a',
        success: (res) => resolve(!!res.confirm),
        fail: () => resolve(false)
      })
    })
    if (!confirm) return

    const goods = this.data.goods || []

    try {
      const failed = []
      for (const id of ids) {
        try {
          const res = await wx.cloud.callFunction({
            name: 'marketApi',
            data: { action: 'delete', id }
          })
          getMarketApiResult(res)
        } catch (e) {
          failed.push({ id, error: e && (e.errMsg || e.message) ? String(e.errMsg || e.message) : 'delete_failed' })
        }
      }

      const failedSet = new Set(failed.map(x => x.id))
      const successIds = ids.filter(id => !failedSet.has(id))
      const nextGoods = goods.filter(g => !successIds.includes(g.id))
      if (successIds.length) {
        markMarketGoodsChanged()
        this._lastHandledGoodsChangeAt = getMarketGoodsChangedAt()
        this._clearMyGoodsCache()
      }
      this._setMyData({
        goods: nextGoods,
        selectedMap: {},
        selectedCount: 0,
        allSelected: false
      })
      if (successIds.length) this._setMyGoodsCache(this.data.activeListingType, nextGoods)

      wx.showToast({
        title: failed.length ? `已删${successIds.length}个，失败${failed.length}个` : '已删除',
        icon: failed.length ? 'none' : 'success'
      })

      // this.setData({ manageMode: false })

    } catch (err) {
      console.error(err)
      wx.showToast({ title: '删除失败（无权限/规则限制）', icon: 'none' })
    } finally {
    }
  },

  // ====== 单删（保留，但在 wxml 里不再用 × 了） ======
  async onDeleteGood(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
  },

  // ====== bio 保存逻辑保持不动 ======
  onBioInput(e) {
    this.setData({ bio: e.detail.value })
  },

  async onBioBlur() {
    const raw = (this.data.bio || '')
    const bio = raw.trim()
    if (bio !== raw) this.setData({ bio })
    if (bio === (this.data.bioOriginal || '')) return
    if (this.data.isSavingBio) return

    this._setMyData({ isSavingBio: true })
    try {
      await this._updateUserBioByCloudFunction(bio)
      this.setData({ bioOriginal: bio })
      wx.showToast({ title: '已保存简介', icon: 'success' })
    } catch (err) {
      console.error('save bio failed', err)
      showDataError('保存失败', err, '简介保存失败，请稍后重试。')
    } finally {
      this._setMyData({ isSavingBio: false })
    }
  },

  _updateUserBioByCloudFunction(bio) {
    return new Promise((resolve, reject) => {
      wx.cloud.callFunction({
        name: 'updateUser',
        data: { bio },
        success: (res) => {
          const ok = res?.result?.ok
          if (ok === false) {
            reject(new Error(res?.result?.errorMsg || '更新失败'))
            return
          }
          resolve(res)
        },
        fail: reject
      })
    })
  },

  loadUserInfo() {
    return new Promise((resolve) => {
      wx.cloud.callFunction({
        name: 'getUserInfo',
        success: (res) => {
          const list = (res?.result?.data) || []
          const user = list[0] || {}

          this._setMyData({
            avatarUrl: user.avatarUrl || defaultAvatarUrl,
            name: user.name || '',
            wechatID: user.wechatID || '',
            region: buildProfileDisplayLocation(user),
            apartment: buildProfileApartmentDisplay(user),
            bio: user.bio || user.intro || '',
            bioOriginal: (user.bio || user.intro || ''),
            openid: user._openid || ''
          })
          resolve()
        },
        fail: (err) => {
          console.error('getUserInfo failed', err)
          showDataError('资料加载失败', err, '个人资料从数据库加载失败，请稍后重试。')
          resolve()
        }
      })
    })
  },

  _getMyGoodsCache(type) {
    this._myGoodsCache = this._myGoodsCache || {}
    return this._myGoodsCache[normalizeListingType(type)] || null
  },

  _getFreshMyGoodsCache(type) {
    const cache = this._getMyGoodsCache(type)
    if (!cache) return null
    if (cache.changedAt !== getMarketGoodsChangedAt()) return null
    return cache
  },

  _setMyGoodsCache(type, goods) {
    this._myGoodsCache = this._myGoodsCache || {}
    this._myGoodsCache[normalizeListingType(type)] = {
      goods: stripSelectionState(goods),
      changedAt: getMarketGoodsChangedAt(),
      cachedAt: Date.now()
    }
  },

  _clearMyGoodsCache(type) {
    if (!this._myGoodsCache) return
    if (type) {
      delete this._myGoodsCache[normalizeListingType(type)]
      return
    }
    this._myGoodsCache = {}
  },

  // ✅ 取 goods 时多带几个字段，方便删文件
  async fetchMyGoods(options = {}) {
    const force = typeof options === 'boolean' ? !!options : !!options.force
    const openid = this.data.openid
    if (!openid) {
      this._setMyData({ goods: [] })
      return
    }

    const listingType = normalizeListingType(this.data.activeListingType)
    const cached = !force ? this._getFreshMyGoodsCache(listingType) : null
    if (cached) {
      this._setMyData({
        goods: cached.goods,
        selectedMap: {},
        selectedCount: 0,
        allSelected: false
      })
      return
    }

    this._myGoodsRequests = this._myGoodsRequests || {}
    if (!force && this._myGoodsRequests[listingType]) {
      try {
        await this._myGoodsRequests[listingType]
      } catch (err) {
        return
      }
      const nextCached = this._getFreshMyGoodsCache(listingType)
      if (nextCached && normalizeListingType(this.data.activeListingType) === listingType) {
        this._setMyData({
          goods: nextCached.goods,
          selectedMap: {},
          selectedCount: 0,
          allSelected: false
        })
      }
      return
    }

    const requestToken = `${listingType}|${Date.now()}`
    this._activeMyGoodsRequestToken = requestToken

    try {
      const PAGE = 50
      const MAX_TOTAL = 1000

      let rows = []
      let skip = 0

      const requestPromise = (async () => {
        while (true) {
          const res = await wx.cloud.callFunction({
            name: 'marketApi',
            data: {
              action: 'myList',
              listingType,
              filters: { listingType },
              skip,
              limit: PAGE
            }
          })
          const result = getMarketApiResult(res)

          const batch = result.items || result.data || []
          rows = rows.concat(batch)

          if (!result.hasMore || batch.length < PAGE) break
          skip = result.nextSkip || (skip + batch.length)
          if (rows.length >= MAX_TOTAL) break
        }
        return rows
      })()
      this._myGoodsRequests[listingType] = requestPromise
      rows = await requestPromise

      const goods = rows.map(buildMyGoodsItem)
      this._setMyGoodsCache(listingType, goods)

      if (normalizeListingType(this.data.activeListingType) !== listingType ||
        this._activeMyGoodsRequestToken !== requestToken) {
        return
      }

      this._setMyData({
        goods,
        selectedMap: {},
        selectedCount: 0,
        allSelected: false
      })
    } catch (err) {
      console.error('fetchMyGoods failed', err)
      showDataError('发布加载失败', err, '我的发布从数据库加载失败，请稍后重试。')
    } finally {
      if (this._myGoodsRequests && this._myGoodsRequests[listingType]) {
        delete this._myGoodsRequests[listingType]
      }
      if (this._activeMyGoodsRequestToken === requestToken) {
        this._activeMyGoodsRequestToken = ''
      }
    }
  }
})
