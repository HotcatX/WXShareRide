function formatBadge(value) {
  const n = Number(value || 0)
  if (!Number.isFinite(n) || n <= 0) return ''
  return n > 99 ? '99+' : String(Math.floor(n))
}

function isSwitchTabUrl(url) {
  return url === '/pages/home/home' ||
    url === '/pages/market/market' ||
    url === '/pages/profile/profile'
}

Component({
  properties: {
    active: {
      type: String,
      value: 'home'
    },
    marketBadge: {
      type: Number,
      value: 0
    },
    profileBadge: {
      type: Number,
      value: 0
    }
  },

  data: {
    displayActive: 'home',
    marketBadgeText: '',
    profileBadgeText: ''
  },

  observers: {
    active: function syncActiveFromProps(active) {
      this.setData({ displayActive: active || 'home' })
    },

    'marketBadge, profileBadge': function syncFromProps(marketBadge, profileBadge) {
      this.setData({
        marketBadgeText: formatBadge(marketBadge),
        profileBadgeText: formatBadge(profileBadge)
      })
    }
  },

  pageLifetimes: {
    show() {
      this.syncBadgesFromStorage()
    }
  },

  lifetimes: {
    attached() {
      this.setData({ displayActive: this.data.active || 'home' })
      this.syncBadgesFromStorage()
    }
  },

  methods: {
    syncBadgesFromStorage() {
      const marketBadge = Number(wx.getStorageSync('customTabMarketBadge') || this.data.marketBadge || 0)
      const profileBadge = Number(wx.getStorageSync('customTabProfileBadge') || this.data.profileBadge || 0)
      this.setData({
        marketBadgeText: formatBadge(marketBadge),
        profileBadgeText: formatBadge(profileBadge)
      })
    },

    onTapTab(e) {
      const dataset = (e.currentTarget && e.currentTarget.dataset) || {}
      const key = dataset.key || ''
      const url = dataset.url || ''
      if (!url || key === this.data.displayActive) return

      if (isSwitchTabUrl(url)) {
        wx.switchTab({
          url,
          fail: () => this.setData({ displayActive: this.data.active || 'home' })
        })
        return
      }

      this.setData({ displayActive: key })

      wx.reLaunch({
        url,
        fail: () => this.setData({ displayActive: this.data.active || 'home' })
      })
    }
  }
})
