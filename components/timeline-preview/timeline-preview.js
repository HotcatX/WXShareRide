const { callPublicPreview } = require('../../utils/publicPreview')

const PAGE_SIZE = 10
const KIND_LABELS = { goods: '闲置转让', sublet: '房屋转租', carpool: '发车路线', request: '乘客求车' }
const MARKET_TABS = [{ type: 'goods', label: '闲置' }, { type: 'sublet', label: '转租' }]
const TRIP_TABS = [{ type: 'all', label: '全部' }, { type: 'carpool', label: '找拼车' }, { type: 'request', label: '求拼车' }]

function positiveNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, number) : 0
}

function previewTopInset() {
  if (typeof wx === 'undefined') return 0
  let info
  try {
    if (typeof wx.getWindowInfo === 'function') info = wx.getWindowInfo()
  } catch (error) {}
  if (!info) {
    try {
      if (typeof wx.getSystemInfoSync === 'function') info = wx.getSystemInfoSync()
    } catch (error) {}
  }
  if (!info) return 0
  const statusHeight = positiveNumber(info.statusBarHeight) || positiveNumber(info.safeArea && info.safeArea.top)
  // Single-page mode overlays a native title bar even with custom navigation.
  // Its capsule can still describe the ordinary mini-program layout, so keep
  // the standard 44px title-bar minimum when the reported capsule is shorter.
  let navigationHeight = 44
  try {
    if (typeof wx.getMenuButtonBoundingClientRect === 'function') {
      const menu = wx.getMenuButtonBoundingClientRect()
      const height = positiveNumber(menu && menu.height)
      const gap = Number(menu && menu.top) - statusHeight
      if (height > 0 && height <= 64 && gap >= 0 && gap <= 24) {
        navigationHeight = Math.min(64, Math.max(navigationHeight, height + gap * 2))
      }
    }
  } catch (error) {}
  // A window that already starts below the native bar needs no second inset.
  return Math.max(0, Math.round(statusHeight + navigationHeight - positiveNumber(info.screenTop)))
}

function cleanText(value, length = 160) {
  return typeof value === 'string' ? value.trim().slice(0, length) : ''
}

function normalizeContext(value) {
  if (!value || !['market', 'trip', 'info'].includes(value.kind)) return null
  const kind = value.kind
  const types = kind === 'market' ? ['goods', 'sublet'] : ['all', 'carpool', 'request']
  return {
    kind,
    type: types.includes(value.type) ? value.type : kind === 'market' ? 'goods' : 'all',
    id: cleanText(value.id),
    cityKey: cleanText(value.cityKey, 100),
    category: cleanText(value.category, 100),
    sellerId: kind === 'market' ? cleanText(value.sellerId) : '',
    title: cleanText(value.title, 80)
  }
}

function viewItem(item) {
  return {
    id: item.id,
    kind: item.kind,
    key: `${item.kind}:${item.id}`,
    kindLabel: KIND_LABELS[item.kind] || '公开信息',
    title: item.title || KIND_LABELS[item.kind] || '公开信息',
    description: item.description,
    priceText: item.priceText,
    regionText: item.regionText,
    timeText: item.timeText,
    availabilityText: item.availabilityText,
    images: item.images,
    tags: item.tags,
    cover: item.images[0] || '',
    coverFailed: false
  }
}

function errorState(error) {
  const unavailable = error && error.code === 'UNAVAILABLE'
  return {
    title: unavailable ? '这条信息暂不可查看' : '暂时没有加载成功',
    message: unavailable
      ? '信息可能已下架、结束或不再公开，可以浏览其他公开信息。'
      : error && error.code === 'TIMEOUT'
        ? '加载时间有点久，请稍后重试。'
        : '请稍后重试，已加载的内容仍可浏览。',
    retryable: !unavailable
  }
}

Component({
  options: { styleIsolation: 'isolated' },

  properties: {
    context: { type: Object, value: {} }
  },

  data: {
    ready: false,
    kind: '',
    type: '',
    mode: 'waiting',
    title: '公开信息',
    tabs: [],
    items: [],
    detail: null,
    detailImages: [],
    fromList: false,
    loading: false,
    loadingMore: false,
    hasMore: false,
    error: null,
    moreError: false,
    scrollTop: 0,
    topInset: 0,
    infoCards: [
      { title: '一起出行', description: '浏览公开的发车路线和求拼车信息，了解出发时间与同行需求。' },
      { title: '闲置转让', description: '发现附近的闲置物品，查看价格、图片和商品说明。' },
      { title: '房屋转租', description: '了解公开的转租房源、所在地区和租住信息。' }
    ]
  },

  observers: {
    context(context) {
      if (this._alive) this._applyContext(context)
    }
  },

  lifetimes: {
    attached() {
      this._alive = true
      this._listSeq = (this._listSeq || 0) + 1
      this._detailSeq = (this._detailSeq || 0) + 1
      this._scrollSeq = (this._scrollSeq || 0) + 1
      this._contextKey = undefined
      this._scrollPosition = 0
      this._listScrollPosition = 0
      this._syncWindowInsets()
      this._applyContext(this.properties.context)
    },
    detached() {
      this._alive = false
      this._listSeq += 1
      this._detailSeq += 1
      this._scrollSeq += 1
    }
  },

  pageLifetimes: {
    resize() {
      this._syncWindowInsets()
    }
  },

  methods: {
    _setData(data, callback) {
      if (!this._alive) return
      this.setData(data, callback)
    },

    _syncWindowInsets() {
      if (!this._alive) return
      const topInset = previewTopInset()
      if (topInset !== this.data.topInset) this._setData({ topInset })
    },

    _scrollTo(position) {
      const sequence = ++this._scrollSeq
      // The native scroll position can change without changing scrollTop data.
      this._setData({ scrollTop: this._scrollPosition || 0 }, () => {
        if (!this._alive || sequence !== this._scrollSeq) return
        this._setData({ scrollTop: position })
        this._scrollPosition = position
      })
    },

    _applyContext(value) {
      const context = normalizeContext(value)
      const key = JSON.stringify(context)
      if (key === this._contextKey) return
      this._contextKey = key
      this._context = context
      this._listSeq += 1
      this._detailSeq += 1
      this._listPending = false
      this._detailPending = false
      this._listLoaded = false
      this._nextOffset = 0
      this._listScrollPosition = 0
      this._detailTarget = null
      this._setData({
        ready: !!context,
        kind: context ? context.kind : '',
        type: context ? context.type : '',
        mode: context ? context.kind === 'info' ? 'info' : context.id ? 'detail' : 'list' : 'waiting',
        title: context ? context.title || (context.kind === 'market' ? context.sellerId ? '公开商品' : '同城好物与转租' : context.kind === 'trip' ? '一起出行' : '同城生活') : '公开信息',
        tabs: context ? context.kind === 'market' ? MARKET_TABS : context.kind === 'trip' ? TRIP_TABS : [] : [],
        items: [],
        detail: null,
        detailImages: [],
        fromList: false,
        loading: false,
        loadingMore: false,
        hasMore: false,
        error: null,
        moreError: false
      })
      this._scrollTo(0)
      if (!context || context.kind === 'info') return
      if (context.id) this._loadDetail(context.id, context.type)
      else this._loadList(false)
    },

    _loadList(append) {
      if (!this._alive || !this._context || this._context.kind === 'info' || this._listPending) return
      if (append && (!this.data.hasMore || !this._listLoaded)) return
      this._listPending = true
      const sequence = ++this._listSeq
      const context = this._context
      const offset = append ? this._nextOffset : 0
      this._setData({ loading: !append, loadingMore: append, moreError: false, error: null })
      callPublicPreview({
        action: context.kind === 'market' ? 'marketList' : 'tripList',
        type: this.data.type,
        offset,
        limit: PAGE_SIZE,
        cityKey: context.cityKey,
        category: context.category,
        sellerId: context.sellerId
      }).then(result => {
        if (!this._alive || sequence !== this._listSeq) return
        const items = append ? this.data.items.slice() : []
        const seen = new Set(items.map(item => item.key))
        result.items.forEach(item => {
          const next = viewItem(item)
          if (!seen.has(next.key)) {
            seen.add(next.key)
            items.push(next)
          }
        })
        this._nextOffset = result.nextOffset
        this._listLoaded = true
        this._listPending = false
        this._setData({ items, hasMore: result.hasMore, loading: false, loadingMore: false })
      }).catch(error => {
        if (!this._alive || sequence !== this._listSeq) return
        this._listPending = false
        this._setData({
          loading: false,
          loadingMore: false,
          moreError: append,
          error: append ? null : errorState(error)
        })
      })
    },

    _loadDetail(id, type) {
      if (!this._alive || !this._context || this._detailPending) return
      this._detailPending = true
      this._detailTarget = { id, type }
      const sequence = ++this._detailSeq
      this._setData({ loading: true, error: null, detail: null, detailImages: [] })
      callPublicPreview({
        action: this._context.kind === 'market' ? 'marketDetail' : 'tripDetail',
        id,
        type
      }).then(result => {
        if (!this._alive || sequence !== this._detailSeq) return
        this._detailPending = false
        this._setData({
          loading: false,
          detail: viewItem(result.item),
          detailImages: result.item.images.map((src, index) => ({ src, key: String(index), failed: false }))
        })
      }).catch(error => {
        if (!this._alive || sequence !== this._detailSeq) return
        this._detailPending = false
        this._setData({ loading: false, error: errorState(error) })
      })
    },

    onSelectType(event) {
      if (!this._alive || this.data.mode !== 'list') return
      const type = event.currentTarget.dataset.type
      if (type === this.data.type || !this.data.tabs.some(tab => tab.type === type)) return
      this._listSeq += 1
      this._listPending = false
      this._listLoaded = false
      this._nextOffset = 0
      this._listScrollPosition = 0
      this._setData({ type, items: [], hasMore: false, error: null, moreError: false })
      this._scrollTo(0)
      this._loadList(false)
    },

    onOpenDetail(event) {
      if (!this._alive || this.data.mode !== 'list') return
      const key = event.currentTarget.dataset.key
      const item = this.data.items.find(candidate => candidate.key === key)
      if (!item) return
      this._listScrollPosition = this._scrollPosition || 0
      this._listSeq += 1
      this._listPending = false
      this._setData({ mode: 'detail', fromList: true, loadingMore: false, moreError: false, error: null })
      this._scrollTo(0)
      this._loadDetail(item.id, item.kind)
    },

    onBackToList() {
      if (!this._alive || this.data.mode !== 'detail') return
      this._detailSeq += 1
      this._detailPending = false
      this._detailTarget = null
      this._setData({ mode: 'list', detail: null, detailImages: [], loading: false, error: null })
      this._scrollTo(this._listLoaded ? this._listScrollPosition : 0)
      if (!this._listLoaded) this._loadList(false)
    },

    onLoadMore() {
      if (this.data.mode === 'list') this._loadList(true)
    },

    onRetry() {
      if (!this._alive || (this.data.error && !this.data.error.retryable)) return
      if (this.data.mode === 'detail' && this._detailTarget) {
        this._loadDetail(this._detailTarget.id, this._detailTarget.type)
      } else if (this.data.mode === 'list') {
        this._loadList(false)
      }
    },

    onScroll(event) {
      if (!this._alive) return
      const top = Number(event.detail.scrollTop)
      this._scrollPosition = Number.isFinite(top) ? Math.max(0, top) : 0
    },

    onListImageError(event) {
      if (!this._alive || this.data.mode !== 'list') return
      const key = event.currentTarget.dataset.key
      this._setData({ items: this.data.items.map(item => item.key === key ? Object.assign({}, item, { coverFailed: true }) : item) })
    },

    onDetailImageError(event) {
      if (!this._alive || this.data.mode !== 'detail') return
      const src = event.currentTarget.dataset.src
      this._setData({ detailImages: this.data.detailImages.map(item => item.src === src ? Object.assign({}, item, { failed: true }) : item) })
    }
  }
})
