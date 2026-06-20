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
    const info = typeof wx.getWindowInfo === "function" ? wx.getWindowInfo() : wx.getSystemInfoSync()
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
        const extra = item.extra || {}
        const rateTripId = extra.tripId || extra.requestId || item.carpoolId || ''
        return {
          ...item,
          createdAtText: this.formatTime(item.createdAt),
          canRate: item.type === 'RATING_INVITE' || extra.action === 'rateUser',
          rateTripId
        }
      })

      const unreadCount = list.filter(it => !it.read).length

      this.setData({
        list,
        loading: false,
        unreadCount
      })

      // 更新自绘底栏红点
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

  async onGoRating(e) {
    const { id, index, tripid } = e.currentTarget.dataset || {}
    const item = this.data.list[index]
    const rateTripId = tripid || (item && item.rateTripId) || ''
    if (!rateTripId) {
      wx.showToast({ title: '缺少历史行程', icon: 'none' })
      return
    }

    if (id && item && !item.read) {
      try {
        const db = wx.cloud.database()
        await db.collection('Notifications').doc(id).update({
          data: { read: true }
        })
        this.setData({ [`list[${index}].read`]: true })
        this.syncUnreadFromList()
      } catch (err) {
        console.error('标记评价通知已读失败：', err)
      }
    }

    wx.navigateTo({
      url: `/pages/profile/tripHistory/tripHistory?rateTripId=${encodeURIComponent(rateTripId)}`
    })
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

        // 更新自绘底栏红点、同步 profile
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
          const callRes = await wx.cloud.callFunction({
            name: 'clearUserNotifications',
            data: {}
          })

          const result = (callRes && callRes.result) || {}
          if (result.success !== true) {
            wx.showToast({
              title: result.errorMsg || '删除失败',
              icon: 'none'
            })
            return
          }

          this.setData({
            list: [],
            unreadCount: 0
          })

          // 更新自绘底栏红点、同步 profile
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
   * 根据当前 list 重新统计未读数量并同步到自绘底栏与 profile
   */
  syncUnreadFromList() {
    const unreadCount = this.data.list.filter(it => !it.read).length
    this.setData({ unreadCount })
    this.updateTabBarBadge(unreadCount)
    this.notifyPrevPage()
  },

  /**
   * 更新自绘底部导航角标
   */
  updateTabBarBadge(count) {
    wx.setStorageSync('customTabProfileBadge', Number(count || 0))
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
