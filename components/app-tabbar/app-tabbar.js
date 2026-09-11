const { rememberTab } = require('../../utils/tabMemory')

function formatBadge(value) {
  const n = Number(value || 0)
  if (!Number.isFinite(n) || n <= 0) return ''
  return n > 99 ? '99+' : String(Math.floor(n))
}

const MARKET_TYPE_KEY = 'market_active_listing_type_v1'

function normalizeMarketType(value) {
  return String(value || '').toLowerCase() === 'sublet' ? 'sublet' : 'goods'
}

function getStoredMarketType() {
  try {
    return normalizeMarketType(wx.getStorageSync(MARKET_TYPE_KEY))
  } catch (e) {
    return 'goods'
  }
}

function setStoredMarketType(type) {
  try {
    wx.setStorageSync(MARKET_TYPE_KEY, normalizeMarketType(type))
  } catch (e) {}
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
    marketType: {
      type: String,
      value: ''
    },
    profileBadge: {
      type: Number,
      value: 0
    }
  },

  data: {
    displayActive: 'home',
    displayMarketType: 'goods',
    marketBadgeText: '',
    profileBadgeText: ''
  },

  observers: {
    active: function syncActiveFromProps(active) {
      this.setData({ displayActive: active || 'home' })
    },

    marketType: function syncMarketTypeFromProps(marketType) {
      const displayMarketType = marketType ? normalizeMarketType(marketType) : getStoredMarketType()
      this.setData({ displayMarketType })
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
      this.syncMarketTypeFromStorage()
      this.syncBadgesFromStorage()
    }
  },

  lifetimes: {
    attached() {
      this.setData({
        displayActive: this.data.active || 'home',
        displayMarketType: this.data.marketType ? normalizeMarketType(this.data.marketType) : getStoredMarketType()
      })
      this.syncBadgesFromStorage()
    }
  },

  methods: {
    syncMarketTypeFromStorage() {
      if (this.data.marketType) return
      this.setData({ displayMarketType: getStoredMarketType() })
    },

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
      if (!url) return
      const rememberSelectedTab = () => {
        if ((key === 'home' && url === '/pages/home/home') ||
          (key === 'profile' && url === '/pages/profile/profile')) {
          rememberTab(key)
        }
      }
      if (key === this.data.displayActive) {
        rememberSelectedTab()
        return
      }

      if (isSwitchTabUrl(url)) {
        wx.switchTab({
          url,
          success: rememberSelectedTab,
          fail: () => this.setData({ displayActive: this.data.active || 'home' })
        })
        return
      }

      this.setData({ displayActive: key })

      wx.reLaunch({
        url,
        success: rememberSelectedTab,
        fail: () => this.setData({ displayActive: this.data.active || 'home' })
      })
    },

    _activateMarketType(type) {
      const nextType = normalizeMarketType(type)
      this.setData({ displayMarketType: nextType })
      setStoredMarketType(nextType)
      this.triggerEvent('marketchange', { type: nextType })

      if (this.data.displayActive === 'market') {
        rememberTab(nextType)
        return
      }

      wx.switchTab({
        url: '/pages/market/market',
        success: () => rememberTab(nextType),
        fail: () => this.setData({ displayActive: this.data.active || 'home' })
      })
    },

    onToggleMarketType() {
      const nextType = this.data.displayActive === 'market'
        ? (this.data.displayMarketType === 'goods' ? 'sublet' : 'goods')
        : this.data.displayMarketType
      this._activateMarketType(nextType)
    },

    onTapMarketType(e) {
      this._activateMarketType(e.currentTarget.dataset.type)
    }
  }
})
