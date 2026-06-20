// pages/market/marketTrade/marketTrade.js
const { showDataError } = require("../../../utils/error")

function formatMarketPrice(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n.toFixed(n % 1 === 0 ? 0 : 2) : '0'
}

function normalizeListingType(value) {
  return String(value || "").toLowerCase() === "sublet" ? "sublet" : "goods"
}

function buildTradeDisplayPatch(type, list = []) {
  return {
    pageTitle: type === 'bought' ? '我买到的' : '我卖出的',
    summaryTitle: type === 'sold' ? '卖出记录' : '买入记录',
    contactRoleText: type === 'sold' ? '买家微信' : '卖家微信',
    listCountText: `${list.length} 条记录`,
    listEmpty: list.length === 0
  }
}

function getMarketApiResult(res) {
  const result = res && res.result
  if (!result || result.ok === false) {
    throw new Error((result && (result.error || result.message)) || "market_api_failed")
  }
  return result
}

function buildTradeItem(x = {}, type = 'sold') {
  const listingType = normalizeListingType(x.listingType)
  const imageKey = x.thumbFileID || x.imageFileID || ''
  const priceText = formatMarketPrice(x.price)
  const title = String(x.title || '').trim() || (listingType === "sublet" ? "未命名房源" : "未命名商品")
  const metaText = listingType === "sublet"
    ? (x.leaseText || x.availableStartDate || x.roomType || x.category || "转租")
    : (x.condition || x.pickupEndDate || "闲置")
  return {
    id: x._id,
    listingType,
    title,
    price: x.price || '',
    priceText,
    priceDisplay: listingType === "sublet" ? `${priceText}/月` : priceText,
    metaText,
    imageFileID: x.imageFileID || '',
    thumbFileID: x.thumbFileID || '',
    hasImage: !!(x.hasImage || x.imageFileID || x.thumbFileID || (Array.isArray(x.imageFileIDs) && x.imageFileIDs.length)),
    imageSrc: x.imageSrc || x.thumbUrl || imageKey || (listingType === "sublet" ? "/images/sublease.png" : "/images/market.png"),
    thumbUrl: x.thumbUrl || '',
    otherOpenid: x.otherOpenid || (type === 'sold'
      ? (x.buyerOpenid || x.buyer_openid || '')
      : (x._openid || '')),
    contactWechat: x.contactWechat || ''
  }
}

Page({
  data: {
    statusBarHeight: 0,
    type: 'sold',          // sold | bought
    pageTitle: '我卖出的',
    summaryTitle: '卖出记录',
    contactRoleText: '买家微信',
    listCountText: '0 条记录',
    listEmpty: true,
    myOpenid: '',
    list: []
  },

  onLoad(options) {
    const sys = typeof wx.getWindowInfo === "function" ? wx.getWindowInfo() : wx.getSystemInfoSync()
    const type = options?.type === 'bought' ? 'bought' : 'sold'

    this.setData({
      statusBarHeight: sys.statusBarHeight || 0,
      type,
      ...buildTradeDisplayPatch(type, [])
    })

    this.init()
  },

  onPullDownRefresh() {
    this.init().finally(() => wx.stopPullDownRefresh())
  },

  onBack() {
    wx.navigateBack({ delta: 1 })
  },

  async init() {
    await this.fetchList()
  },

  async fetchList() {
    try {
      const PAGE = 50
      const MAX_TOTAL = 1000

      let rows = []
      let skip = 0
      let myOpenid = this.data.myOpenid || ''

      while (true) {
        const res = await wx.cloud.callFunction({
          name: 'marketApi',
          data: { action: 'tradeList', type: this.data.type, skip, limit: PAGE }
        })
        const result = getMarketApiResult(res)
        if (result.openid) myOpenid = result.openid

        const batch = result.items || result.data || []
        rows = rows.concat(batch)

        if (!result.hasMore || batch.length < PAGE) break
        skip = result.nextSkip || (skip + batch.length)
        if (rows.length >= MAX_TOTAL) break
      }

      const list = rows.map(x => buildTradeItem(x, this.data.type))

      this.setData({
        myOpenid,
        list,
        ...buildTradeDisplayPatch(this.data.type, list)
      })
    } catch (e) {
      console.error('fetchList error', e)
      showDataError('交易加载失败', e, '交易列表从数据库加载失败，请稍后重试。')
    }
  },

  onOpenDetail(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: `/pages/market/marketDetail/marketDetail?id=${id}` })
  },

  // ✅ 黄色按钮：复制对方微信号
  onCopyWechat(e) {
    const wxid = e.currentTarget.dataset.wx || ''
    if (!wxid) {
      wx.showToast({ title: '对方未填写微信号', icon: 'none' })
      return
    }
    wx.setClipboardData({
      data: wxid,
      success: () => wx.showToast({ title: '已复制微信号', icon: 'success' })
    })
  }
})
