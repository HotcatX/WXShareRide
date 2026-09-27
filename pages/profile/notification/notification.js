const notifications = require('../../../utils/compat/notifications')

Page({
  data: { list: [], loading: true, statusBarHeight: 80, pageTitle: '消息通知', unreadCount: 0 },

  onLoad() {
    this._unloaded = false
    this._epoch = (this._epoch || 0) + 1
    this._loadSequence = 0
    const info = typeof wx.getWindowInfo === 'function' ? wx.getWindowInfo() : wx.getSystemInfoSync()
    this.setData({ statusBarHeight: info.statusBarHeight })
  },
  onShow() { return this.loadList() },
  onUnload() { this._unloaded = true; this._epoch = (this._epoch || 0) + 1; this._loadSequence = (this._loadSequence || 0) + 1 },
  context() { return { epoch: this._epoch, identity: notifications.identity() } },
  current(context) { return !this._unloaded && context.epoch === this._epoch && context.identity === notifications.identity() },
  goBack() { wx.navigateBack({ delta: 1 }) },
  async onPullDownRefresh() { try { await this.loadList() } finally { if (!this._unloaded) wx.stopPullDownRefresh() } },

  async loadList({ failureTitle = '加载失败，请重试' } = {}) {
    if (this._unloaded) return false
    const context = this.context(), sequence = this._loadSequence = (this._loadSequence || 0) + 1
    const current = () => this.current(context) && sequence === this._loadSequence
    if (this._listIdentity !== context.identity) {
      this._listIdentity = context.identity
      this.setData({ list: [], unreadCount: 0 })
      this.updateTabBarBadge(0)
    }
    this.setData({ loading: true })
    if (!notifications.signedIn()) {
      this.setData({ list: [], loading: false, unreadCount: 0 })
      this.updateTabBarBadge(0)
      return false
    }
    try {
      const result = await notifications.list()
      if (!current()) return false
      this.setData({ list: result.items.map(item => ({ ...item, createdAtText: this.formatTime(item.createdAt) })),
        loading: false, unreadCount: result.unreadCount })
      // This count includes notices outside the first 100 rows.
      this.updateTabBarBadge(result.unreadCount)
      return true
    } catch (_) {
      if (current()) { this.setData({ loading: false }); wx.showToast({ title: failureTitle, icon: 'none' }) }
      return false
    }
  },

  formatTime(value) {
    if (!value) return ''
    const date = value instanceof Date ? value : value.toDate && typeof value.toDate === 'function'
      ? value.toDate() : new Date(value.$date === undefined ? value : value.$date)
    if (!Number.isFinite(date.getTime())) return ''
    const pad = number => String(number).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  },
  item(event) {
    if (this._listIdentity !== notifications.identity()) return null
    const id = event && event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.id
    return this.data.list.find(item => item._id === id)
  },
  async runMutation(operation, successTitle) {
    const context = this.context()
    if (!this.current(context)) return false
    if (!notifications.signedIn()) { wx.showToast({ title: '请先登录', icon: 'none' }); return false }
    if (this._mutation && this.current(this._mutation)) return false
    this._mutation = context
    this._loadSequence = (this._loadSequence || 0) + 1
    this.setData({ loading: false })
    try {
      await operation()
      if (!this.current(context)) return false
      // Re-read after the transaction: read-all/clear must preserve later arrivals.
      const refreshed = await this.loadList({ failureTitle: '操作已完成，刷新失败，请下拉重试' })
      if (!this.current(context)) return false
      this.notifyPrevPage()
      if (refreshed && successTitle) wx.showToast({ title: successTitle, icon: 'success' })
      return true
    } catch (error) {
      if (this.current(context)) wx.showToast({ title: error.message || '操作失败，请重试', icon: 'none' })
      return false
    } finally { if (this._mutation === context) this._mutation = null }
  },
  async onTapItem(event) {
    const item = this.item(event)
    if (!item || item.read) return
    await this.runMutation(() => notifications.markRead(item._id))
  },
  async onGoRating(event) {
    const context = this.context(), item = this.item(event)
    if (!item || !item.canRate || !item.rateTripId) { wx.showToast({ title: '缺少历史行程', icon: 'none' }); return }
    if (!item.read) await this.runMutation(() => notifications.markRead(item._id))
    if (this.current(context)) wx.navigateTo({ url: `/pages/profile/tripHistory/tripHistory?rateTripId=${encodeURIComponent(item.rateTripId)}` })
  },
  async onMarkAllRead() {
    if (this.data.unreadCount <= 0) return
    await this.runMutation(() => notifications.markAllRead(), '已全部标为已读')
  },
  onDeleteAll() {
    if (!this.data.list.length) return
    const context = this.context()
    wx.showModal({ title: '提示', content: '确定要删除所有消息吗？此操作不可恢复。', success: async result => {
      if (result.confirm && this.current(context)) await this.runMutation(() => notifications.clear(), '已删除所有消息')
    } })
  },
  updateTabBarBadge(count) { wx.setStorageSync('customTabProfileBadge', Number(count || 0)) },
  notifyPrevPage() {
    const pages = getCurrentPages(), previous = pages[pages.length - 2]
    if (previous && typeof previous.loadUnreadCount === 'function') previous.loadUnreadCount()
  }
})
