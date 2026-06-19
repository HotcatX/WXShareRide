// pages/profile/notification/notification.js
Page({
  data: {
    list: [],             // 通知列表
    loading: true,        // 是否在加载中
    statusBarHeight: 80,
    pageTitle: '消息通知',
    unreadCount: 0        // 未读数量
  },

  onLoad() {
    const info = wx.getSystemInfoSync()
    this.setData({
      statusBarHeight: info.statusBarHeight
    })
  },

  onShow() {
    this.loadList()
  },

  // 返回上一页
  goBack() {
    wx.navigateBack({ delta: 1 })
  },

  // 下拉刷新
  async onPullDownRefresh() {
    try {
      await this.loadList()
    } catch (e) {
      console.error('onPullDownRefresh error', e)
    } finally {
      wx.stopPullDownRefresh()
    }
  },


  /**
   * 读取 Notifications 集合中的消息
   * 只读取当前用户的通知
   */
  async loadList() {
    this.setData({ loading: true })
    const openid = wx.getStorageSync('openid')

    if (!openid) {
      this.setData({
        list: [],
        loading: false,
        unreadCount: 0
      })
      this.updateTabBarBadge(0)
      return
    }

    const db = wx.cloud.database()

    try {
      const res = await db.collection('Notifications')
        .where({
          _openid: openid
        })
        .orderBy('createdAt', 'desc')
        .limit(100)
        .get()

      const rawList = res.data || []

      const list = rawList.map(item => {
        return {
          ...item,
          createdAtText: this.formatTime(item.createdAt)
        }
      })

      const unreadCount = list.filter(it => !it.read).length

      this.setData({
        list,
        loading: false,
        unreadCount
      })

      // 更新底部 tabBar 的红点
      this.updateTabBarBadge(unreadCount)

    } catch (err) {
      console.error('加载通知失败：', err)
      wx.showToast({
        title: '加载失败',
        icon: 'none'
      })
      this.setData({ loading: false })
    }
  },

  /**
   * 时间格式化：YYYY-MM-DD HH:mm
   */
  formatTime(t) {
    if (!t) return ''
    let d

    if (t instanceof Date) {
      d = t
    } else if (t.toDate && typeof t.toDate === 'function') {
      d = t.toDate()
    } else {
      d = new Date(t)
    }

    const y = d.getFullYear()
    const m = (d.getMonth() + 1).toString().padStart(2, '0')
    const day = d.getDate().toString().padStart(2, '0')
    const hh = d.getHours().toString().padStart(2, '0')
    const mm = d.getMinutes().toString().padStart(2, '0')

    return `${y}-${m}-${day} ${hh}:${mm}`
  },

  /**
   * 单条点击 → 设为已读
   */
  async onTapItem(e) {
    const { id, index } = e.currentTarget.dataset
    const item = this.data.list[index]
    if (!item || item.read) return

    const db = wx.cloud.database()

    try {
      await db.collection('Notifications').doc(id).update({
        data: { read: true }
      })

      const key = `list[${index}].read`
      this.setData({ [key]: true })

      this.syncUnreadFromList()

    } catch (err) {
      console.error('标记已读失败：', err)
      wx.showToast({
        title: '操作失败',
        icon: 'none'
      })
    }
  },

  /**
   * 一键全部标为已读
   * ⭐ 只标记当前用户自己的未读消息
   */
  async onMarkAllRead() {
    // 虽然按钮 disabled 了，这里加一道保险
    if (this.data.unreadCount <= 0) return

    const openid = wx.getStorageSync('openid')
    if (!openid) {
      wx.showToast({
        title: '请先登录',
        icon: 'none'
      })
      return
    }

    const db = wx.cloud.database()


    try {
      await db.collection('Notifications')
        .where({
          _openid: openid,
          read: false
        })
        .update({
          data: { read: true }
        })

      // 本地全部改为已读
      const newList = this.data.list.map(item => ({
        ...item,
        read: true
      }))

      this.setData({
        list: newList,
        unreadCount: 0
      })

      // 更新 tabBar 红点、同步 profile
      this.updateTabBarBadge(0)
      this.notifyPrevPage()

      wx.showToast({
        title: '已全部标为已读',
        icon: 'success'
      })
    } catch (err) {
      console.error('全部标为已读失败：', err)
      wx.showToast({
        title: '操作失败',
        icon: 'none'
      })
    } finally {
    }
  },

  /**
   * 一键删除所有消息（调用云函数）
   */
  onDeleteAll() {
    if (this.data.list.length === 0) return

    wx.showModal({
      title: '提示',
      content: '确定要删除所有消息吗？此操作不可恢复。',
      success: async (res) => {
        if (!res.confirm) return


        try {
          // 调用云函数，删除当前用户在 Notifications 集合下的所有记录
          const callRes = await wx.cloud.callFunction({
            name: 'clearUserNotifications',
            data: {}
          })

          console.log('clearUserNotifications result:', callRes)

          // 本地列表清空
          this.setData({
            list: [],
            unreadCount: 0
          })

          // 更新 tabBar 红点、同步 profile
          this.updateTabBarBadge(0)
          this.notifyPrevPage()

          wx.showToast({
            title: '已删除所有消息',
            icon: 'success'
          })
        } catch (err) {
          console.error('删除所有消息失败：', err)
          wx.showToast({
            title: '操作失败',
            icon: 'none'
          })
        } finally {
        }
      }
    })
  },

  /**
   * 根据当前 list 重新统计未读数量并同步到 tabBar & profile
   */
  syncUnreadFromList() {
    const unreadCount = this.data.list.filter(it => !it.read).length
    this.setData({ unreadCount })
    this.updateTabBarBadge(unreadCount)
    this.notifyPrevPage()
  },

  /**
   * 更新底部 tabBar 角标
   */
  updateTabBarBadge(count) {
    if (typeof wx.setTabBarBadge !== 'function') return

    const index = 2

    if (count > 0) {
      wx.setTabBarBadge({
        index,
        text: count > 99 ? '99+' : String(count)
      })
    } else {
      wx.removeTabBarBadge({
        index
      })
    }
  },

  /**
   * 通知上一页（通常是 profile）刷新未读数量
   */
  notifyPrevPage() {
    const pages = getCurrentPages()
    const prevPage = pages[pages.length - 2]
    if (prevPage && typeof prevPage.loadUnreadCount === 'function') {
      prevPage.loadUnreadCount()
    }
  }
})
