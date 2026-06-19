// pages/market/marketMy/marketMy.js
const defaultAvatarUrl =
  'https://mmbiz.qpic.cn/mmbiz/icTdbqWNOwNRna42FI242Lcia07jQodd2FJGIYQfG0LAJGFxM4FbnQP6yfMxBgJ0F3YRqJCJ1aPAK2dQagdusBZg/0'

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
    goods: [],

    // ✅ 管理模式 = 多选模式
    manageMode: false,

    // ✅ 多选状态
    selectedMap: {},   // { [id]: true }
    selectedCount: 0,
    allSelected: false
  },

  onLoad() {
    const sys = wx.getSystemInfoSync()
    this.setData({ statusBarHeight: sys.statusBarHeight || 0 })

    wx.showShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] })

    this.loadUserInfo().then(() => {
      this.fetchMyGoods()
    })
  },

  onShareAppMessage() {
    const openid = this.data.openid || ''
    const title = this.data.name ? `看看 ${this.data.name} 的二手商品` : '查看卖家二手商品'
    return { title, path: `/pages/market/marketSeller/marketSeller?openid=${encodeURIComponent(openid)}` }
  },

  onShareTimeline() {
    const openid = this.data.openid || ''
    const title = this.data.name ? `看看 ${this.data.name} 的二手商品` : '查看卖家二手商品'
    return { title, query: `openid=${encodeURIComponent(openid)}` }
  },

  onPullDownRefresh() {
    Promise.resolve()
      .then(() => this.loadUserInfo())
      .then(() => this.fetchMyGoods(true))
      .finally(() => wx.stopPullDownRefresh())
  },

  onBack() {
    const pages = getCurrentPages()
    if (pages.length > 1) {
      wx.navigateBack({ delta: 1 })
      return
    }
  
    // 栈里只有当前页：说明是分享/收藏/redirect 进来的，必须回 tab
    wx.switchTab({
      url: '/pages/market/market'   // ← 改成你的“主页面/拼车所在 tab 页”
    })
  },

  onAddGood() {
    wx.navigateTo({ url: '/pages/market/marketPost/marketPost' })
  },

  // ✅ 进入/退出多选管理
  onToggleManage() {
    const next = !this.data.manageMode
    this.setData({
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

    this.setData({ selectedMap: map, selectedCount, allSelected })
  },

  // ✅ 全选/取消全选
  onToggleSelectAll() {
    const goods = this.data.goods || []
    if (!goods.length) return

    if (this.data.allSelected) {
      this.setData({ selectedMap: {}, selectedCount: 0, allSelected: false })
      return
    }

    const map = {}
    goods.forEach(g => { if (g?.id) map[g.id] = true })
    this.setData({ selectedMap: map, selectedCount: goods.length, allSelected: true })
  },

  // ✅ 批量删除
  async onDeleteSelected() {
    const ids = Object.keys(this.data.selectedMap || {})
    if (!ids.length) {
      wx.showToast({ title: '请先选择要删除的商品', icon: 'none' })
      return
    }

    const confirm = await new Promise((resolve) => {
      wx.showModal({
        title: `确认删除 ${ids.length} 个商品？`,
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
            name: 'deleteMarketItem',
            data: { id }
          })
          const r = res?.result || {}
          if (!r.ok) failed.push({ id, error: r.error || 'delete_failed' })
        } catch (e) {
          failed.push({ id, error: e && (e.errMsg || e.message) ? String(e.errMsg || e.message) : 'delete_failed' })
        }
      }

      const failedSet = new Set(failed.map(x => x.id))
      const successIds = ids.filter(id => !failedSet.has(id))
      const nextGoods = goods.filter(g => !successIds.includes(g.id))
      this.setData({
        goods: nextGoods,
        selectedMap: {},
        selectedCount: 0,
        allSelected: false
      })

      wx.showToast({
        title: failed.length ? `已删${successIds.length}个，失败${failed.length}个` : '已删除',
        icon: failed.length ? 'none' : 'success'
      })

      // 可选：删完自动退出管理模式
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
    // 你原来的单删逻辑保留即可（不用也没关系）
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

    this.setData({ isSavingBio: true })
    try {
      await this._updateUserBioByCloudFunction(bio)
      this.setData({ bioOriginal: bio })
      wx.showToast({ title: '已保存简介', icon: 'success' })
    } catch (err) {
      console.error('save bio failed', err)
      try {
        const openid = this.data.openid
        if (openid) {
          const db = wx.cloud.database()
          await db.collection('userInfo').where({ _openid: openid }).update({ data: { bio } })
          this.setData({ bioOriginal: bio })
          wx.showToast({ title: '已保存简介', icon: 'success' })
        } else {
          wx.showToast({ title: '保存失败', icon: 'none' })
        }
      } catch (e2) {
        console.error('save bio fallback failed', e2)
        wx.showToast({ title: '保存失败', icon: 'none' })
      }
    } finally {
      this.setData({ isSavingBio: false })
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

          this.setData({
            avatarUrl: user.avatarUrl || defaultAvatarUrl,
            name: user.name || '',
            wechatID: user.wechatID || '',
            region: user.address || '',
            apartment: user.bigregion || '',
            bio: user.bio || user.intro || '',
            bioOriginal: (user.bio || user.intro || ''),
            openid: user._openid || ''
          })
          resolve()
        },
        fail: (err) => {
          console.error('getUserInfo failed', err)
          wx.showToast({ title: '加载用户信息失败', icon: 'none' })
          resolve()
        }
      })
    })
  },

  // ✅ 取 goods 时多带几个字段，方便删文件
  async fetchMyGoods() {
    const openid = this.data.openid
    if (!openid) {
      this.setData({ goods: [] })
      return
    }

    const db = wx.cloud.database()
    try {
      const PAGE = 20
      const MAX_TOTAL = 1000

      let rows = []
      let skip = 0

      while (true) {
        const res = await db.collection('market_goods')
          .where({ _openid: openid })
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

      let goods = rows.map((x) => ({
        id: x._id,
        title: x.title,
        price: x.price,
        imageFileID: x.imageFileID || '',
        imageFileIDs: Array.isArray(x.imageFileIDs) ? x.imageFileIDs : [],
        thumbFileID: x.thumbFileID || '',
        thumbFileIDs: Array.isArray(x.thumbFileIDs) ? x.thumbFileIDs : [],
        hasImage: !!(x.hasImage || x.imageFileID || x.thumbFileID || (Array.isArray(x.imageFileIDs) && x.imageFileIDs.length)),
        pickupEndDate: x.pickupEndDate || x.expiresAtText || '',
        expireTime: Number(x.expireTime) || 0,
        status: x.status || 'online',
        thumbUrl: ''
      }))

      const fileIDs = goods.map((g) => g.thumbFileID || g.imageFileID).filter(Boolean)
      if (fileIDs.length) {
        const urlMap = await this._batchGetTempUrl(fileIDs)
        goods = goods.map((g) => ({ ...g, thumbUrl: urlMap[g.thumbFileID || g.imageFileID] || '' }))
      }

      this.setData({
        goods,
        // 刷新列表时，顺手清空选择
        selectedMap: {},
        selectedCount: 0,
        allSelected: false
      })
    } catch (err) {
      console.error('fetchMyGoods failed', err)
      wx.showToast({ title: '加载我的发布失败', icon: 'none' })
      this.setData({ goods: [] })
    }
  },

  async _batchGetTempUrl(fileIDs) {
    const uniq = Array.from(new Set(fileIDs))
    const map = {}
    const chunkSize = 50

    for (let i = 0; i < uniq.length; i += chunkSize) {
      const chunk = uniq.slice(i, i + chunkSize)
      const res = await wx.cloud.getTempFileURL({ fileList: chunk })
      ;(res.fileList || []).forEach((it) => {
        if (it.fileID && it.tempFileURL) map[it.fileID] = it.tempFileURL
      })
    }
    return map
  }
})
