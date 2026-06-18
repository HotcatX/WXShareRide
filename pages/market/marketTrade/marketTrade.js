// pages/market/marketTrade/marketTrade.js
Page({
  data: {
    statusBarHeight: 0,
    type: 'sold',          // sold | bought
    pageTitle: '我卖出的',
    myOpenid: '',
    list: []
  },

  onLoad(options) {
    const sys = wx.getSystemInfoSync()
    const type = options?.type === 'bought' ? 'bought' : 'sold'

    this.setData({
      statusBarHeight: sys.statusBarHeight || 0,
      type,
      pageTitle: type === 'bought' ? '我买到的' : '我卖出的'
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
    await this.loadMyOpenid()
    await this.fetchList()
  },

  // 你已有 getUserInfo 云函数：返回 userInfo 当前用户
  loadMyOpenid() {
    return new Promise((resolve) => {
      wx.cloud.callFunction({
        name: 'getUserInfo',
        success: (res) => {
          const user = res?.result?.data?.[0] || {}
          this.setData({ myOpenid: user._openid || '' })
          resolve()
        },
        fail: (err) => {
          console.error('getUserInfo fail', err)
          this.setData({ myOpenid: '' })
          resolve()
        }
      })
    })
  },

  async fetchList() {
    const openid = this.data.myOpenid
    if (!openid) {
      this.setData({ list: [] })
      return
    }
  
    const db = wx.cloud.database()
    const _ = db.command
  
    // ✅ sold：我=卖家；bought：我=买家
    let query = null
    if (this.data.type === 'sold') {
      query = _.or([
        { _openid: openid, isSold: true },
        { _openid: openid, sold: true },
        { _openid: openid, status: 'sold' }
      ])
    } else {
      query = _.or([
        { buyerOpenid: openid, isSold: true },
        { buyerOpenid: openid, sold: true },
        { buyerOpenid: openid, status: 'sold' },
  
        { buyer_openid: openid, isSold: true },
        { buyer_openid: openid, sold: true },
        { buyer_openid: openid, status: 'sold' }
      ])
    }
  
    try {
      const PAGE = 20
      const MAX_TOTAL = 1000
  
      let rows = []
      let skip = 0
  
      while (true) {
        const res = await db.collection('market_goods')
          .where(query)
          .orderBy('createTime', 'desc')
          .skip(skip)
          .limit(PAGE)
          .get()
  
        const batch = res.data || []
        rows = rows.concat(batch)
  
        if (batch.length < PAGE) break
        skip += PAGE
        if (rows.length >= MAX_TOTAL) break
      }
  
      // 先把列表基础字段整理好
      let list = rows.map(x => ({
        id: x._id,
        title: x.title || '',
        price: x.price || '',
        imageFileID: x.imageFileID || '',
        thumbUrl: '',
  
        otherOpenid: (this.data.type === 'sold')
          ? (x.buyerOpenid || x.buyer_openid || '')
          : (x._openid || ''),
  
        contactWechat: ''
      }))
  
      // 1) 图片：批量临时链接
      const fileIDs = list.map(it => it.imageFileID).filter(Boolean)
      if (fileIDs.length) {
        const urlMap = await this._batchGetTempUrl(fileIDs)
        list = list.map(it => ({ ...it, thumbUrl: urlMap[it.imageFileID] || '' }))
      }
  
      // 2) 微信号：批量通过 openid 查 userInfo.wechatID
      const otherOpenids = Array.from(new Set(list.map(it => it.otherOpenid).filter(Boolean)))
      if (otherOpenids.length) {
        const wxMap = await this._batchGetWechatByOpenids(otherOpenids)
        list = list.map(it => ({ ...it, contactWechat: wxMap[it.otherOpenid] || '' }))
      }
  
      this.setData({ list })
    } catch (e) {
      console.error('fetchList error', e)
      this.setData({ list: [] })
      wx.showToast({ title: '加载失败', icon: 'none' })
    }
  },  

  // ✅ 你原来用过的临时链接批量函数
  async _batchGetTempUrl(fileIDs) {
    const uniq = Array.from(new Set(fileIDs))
    const map = {}
    const chunkSize = 50

    for (let i = 0; i < uniq.length; i += chunkSize) {
      const chunk = uniq.slice(i, i + chunkSize)
      const res = await wx.cloud.getTempFileURL({ fileList: chunk })
      ;(res.fileList || []).forEach(it => {
        if (it.fileID && it.tempFileURL) map[it.fileID] = it.tempFileURL
      })
    }
    return map
  },

  // ✅ 调你现成云函数：getUserInfoByOpenids(openids[])，取 wechatID
  _batchGetWechatByOpenids(openids) {
    return new Promise((resolve) => {
      wx.cloud.callFunction({
        name: 'getUserInfoByOpenids',
        data: { openids },
        success: (res) => {
          const arr = res?.result?.data || []
          const map = {}
          arr.forEach(u => {
            if (u._openid) {
              map[u._openid] = u.wechatID || u.wechatId || u.wechat || ''
            }
          })
          resolve(map)
        },
        fail: (err) => {
          console.error('getUserInfoByOpenids fail', err)
          resolve({})
        }
      })
    })
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
