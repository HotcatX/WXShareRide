const defaultAvatarUrl = 'https://mmbiz.qpic.cn/mmbiz/icTdbqWNOwNRna42FI242Lcia07jQodd2FJGIYQfG0LAJGFxM4FbnQP6yfMxBgJ0F3YRqJCJ1aPAK2dQagdusBZg/0'
const { showDataError } = require('../../../utils/error')

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function hasLatLng(location = {}) {
  return toFiniteNumber(location.lat ?? location.latitude) !== null &&
    toFiniteNumber(location.lng ?? location.longitude) !== null
}

function getLocationDisplay(location = {}, address = '') {
  return normalizeText(
    location.displayName ||
    location.name ||
    location.buildingName ||
    location.address ||
    address
  )
}

Page({
  data: {
    from: 'profile',

    // 原来 wechat1 / wechat2 合并为一个字段
    wechat: '',
    address: '',
    location: {},
    locationDisplay: '',

    // ✅ 所住区域（存到 userInfo.bigregion）
    bigregion: '',
    locationPicking: false,
    regionTree: [],
    regionPickerVisible: false,
    regionPickerValue: [0, 0, 0],
    regionCol1: ['加载中'],
    regionCol2: ['加载中'],
    regionCol3: ['加载中'],

    phone: '',
    regionIndex: 0,
    regions: ['美国', '中国大陆'],
    statusBarHeight: 80,
    pageTitle: '编辑个人信息',

    name: '',
    avatarUrl: defaultAvatarUrl,
    zelleName: '',
    zelleAccount: '',

    // 车辆信息
    carNumber: '',
    carBrand: '',
    carModel: '',

    // 自定义价格（选填）
    customPriceNonCore: '',
    customPriceCore: '',

    unsaved: false
  },

  async goBack() {
    if (this.data.unsaved) {
      await this.saveToCloud({ silent: true, waitForActive: true })
    }
    wx.navigateBack()
  },

  onLoad(options) {
    const info = typeof wx.getWindowInfo === "function" ? wx.getWindowInfo() : wx.getSystemInfoSync()
    this.setData({
      statusBarHeight: info.statusBarHeight
    })

    const from = options.from || 'profile'
    this.setData({ from })

    // 拉取云端 userInfo
    this.loadUserInfo()
    this.loadRegionTreeFromCloud()
  },

  onHide() {
    if (this.data.unsaved) this.saveToCloud({ silent: true })
  },

  onUnload() {
    if (this.data.unsaved) this.saveToCloud({ silent: true })
  },

  markDirty() {
    this.setData({ unsaved: true })
  },

  async markDirtyAndSave() {
    this.markDirty()
    return this.saveToCloud({ silent: true, waitForActive: true })
  },

  markCurrentAsSaved() {
    this._lastSavedPayloadKey = this.getSavePayloadKey()
    this.setData({ unsaved: false })
  },

  // 上传头像
  async onChooseAvatar(e) {
    const { avatarUrl } = e.detail || {}
    if (!avatarUrl) return


    try {
      const extMatch = avatarUrl.match(/\.(\w+)$/)
      const ext = extMatch ? extMatch[1] : 'jpg'
      const cloudPath = `userAvatar/${Date.now()}-${Math.floor(Math.random() * 1000000)}.${ext}`

      const uploadRes = await wx.cloud.uploadFile({
        cloudPath,
        filePath: avatarUrl
      })

      this.setData({
        avatarUrl: uploadRes.fileID
      })
      this.markDirtyAndSave()
    } catch (err) {
      console.error('上传头像失败：', err)
      wx.showToast({ title: '头像上传失败，请重试', icon: 'none' })
    } finally {
    }
  },

  // 拉取云端现有 userInfo
  async loadUserInfo() {
    try {
      const res = await wx.cloud.callFunction({ name: 'getUserInfo' })
      if (res.result && res.result.data && res.result.data.length > 0) {
        const user = res.result.data[0]
        const cp = user.customPrice || {}
        const location = user.location || {}

        this.setData({
          wechat: user.wechatID || '',
          address: user.address || '',
          location,
          locationDisplay: hasLatLng(location) ? getLocationDisplay(location, '') : '',
          bigregion: user.bigregion || '',

          phone: user.phone || '',
          regionIndex: (user.region === 'CN') ? 1 : 0,
          name: user.name || '',
          avatarUrl: user.avatarUrl || this.data.avatarUrl,
          zelleName: user.zelleName || '',
          zelleAccount: user.zelleAccount || '',
          carNumber: user.carNumber || '',
          carBrand: user.carBrand || '',
          carModel: user.carModel || '',
          customPriceNonCore: cp.fortLeeNonCore || '',
          customPriceCore: cp.fortLeeCore || ''
        }, () => this.markCurrentAsSaved())
      } else {
        this.markCurrentAsSaved()
      }
    } catch (e) {
      console.error('loadUserInfo 失败：', e)
      showDataError('资料加载失败', e, '个人资料从数据库加载失败，请稍后重试。')
    }
  },

  onInput(e) {
    const { field } = e.currentTarget.dataset
    const value = e.detail.value
    if (field === 'address') {
      this.setData({
        address: value,
        bigregion: value
      })
      this.markDirty()
      return
    }
    this.setData({ [field]: value })
    this.markDirty()
  },

  async loadRegionTreeFromCloud() {
    try {
      const db = wx.cloud.database()
      let docData = null
      try {
        const doc = await db.collection('regionTree').doc('default').get()
        docData = doc?.data || null
      } catch (e) {}

      if (!docData) {
        const res = await db.collection('regionTree').limit(1).get()
        docData = (res.data || [])[0] || null
      }

      let tree = docData
      if (tree && Array.isArray(tree.tree)) tree = tree.tree
      tree = (Array.isArray(tree) ? tree : []).filter(x => x && x.label && x.label !== '全部')
      if (!tree.length) throw new Error('regionTree 数据为空或格式错误')

      const lv1 = tree[0]
      const col1 = tree.map(x => x.label)
      const col2 = (lv1.children || []).map(x => x.label)
      const lv2 = (lv1.children || [])[0] || { children: [] }
      const col3 = (lv2.children || []).filter(Boolean)

      this.setData({
        regionTree: tree,
        regionPickerValue: [0, 0, 0],
        regionCol1: col1,
        regionCol2: col2.length ? col2 : ['未设置'],
        regionCol3: col3.length ? col3 : ['未设置']
      })
    } catch (e) {
      console.error('regionTree 加载失败：', e)
      this.setData({
        regionTree: [],
        regionPickerValue: [0, 0, 0],
        regionCol1: ['加载失败'],
        regionCol2: ['加载失败'],
        regionCol3: ['加载失败']
      })
    }
  },

  async onTapRegionPicker() {
    if (!this.data.regionTree.length) {
      await this.loadRegionTreeFromCloud()
    }

    if (!this.data.regionTree.length) {
      wx.showToast({ title: '地区配置加载失败', icon: 'none' })
      return
    }

    this.setData({ regionPickerVisible: true })
  },

  onRegionPickerChange(e) {
    const v = Array.isArray(e.detail.value) ? e.detail.value : [0, 0, 0]
    const [v0, v1] = v
    const tree = this.data.regionTree || []
    const lv1 = tree[v0] || tree[0] || { children: [] }
    const col2 = (lv1.children || []).map(x => x.label)
    const lv2 = (lv1.children || [])[v1] || (lv1.children || [])[0] || { children: [] }
    const col3 = (lv2.children || []).filter(Boolean)

    this.setData({
      regionPickerValue: v,
      regionCol2: col2.length ? col2 : ['未设置'],
      regionCol3: col3.length ? col3 : ['未设置']
    })
  },

  onRegionPickerCancel() {
    this.setData({ regionPickerVisible: false })
  },

  onRegionPickerConfirm() {
    const pickerValue = Array.isArray(this.data.regionPickerValue) ? this.data.regionPickerValue : [0, 0, 0]
    const [v0, v1, v2] = pickerValue
    const tree = this.data.regionTree || []
    const lv1 = tree[v0] || tree[0]
    const lv2 = (lv1?.children || [])[v1] || (lv1?.children || [])[0]
    const lv3 = (this.data.regionCol3 || [])[v2]
    const parts = [
      lv1?.label,
      lv2?.label,
      lv3
    ].map(normalizeText).filter(x => x && x !== '全部' && x !== '未设置')
    const address = parts.join(' / ')

    if (!address) {
      wx.showToast({ title: '请选择具体地区', icon: 'none' })
      return
    }

    this.setData({
      address,
      bigregion: address,
      regionPickerVisible: false
    })
    this.markDirtyAndSave()
  },

  stopTouchMove() {},

  onChooseLocation() {
    if (this.data.locationPicking) return
    if (typeof wx.chooseLocation !== 'function') {
      wx.showToast({ title: '当前版本不支持选点', icon: 'none' })
      return
    }

    this.setData({ locationPicking: true })
    wx.chooseLocation({
      success: res => {
        const lat = toFiniteNumber(res.latitude)
        const lng = toFiniteNumber(res.longitude)
        if (lat === null || lng === null) {
          wx.showToast({ title: '未获取到坐标', icon: 'none' })
          return
        }

        const name = normalizeText(res.name)
        const address = normalizeText(res.address)
        const displayName = name || address || '已选择位置'
        const location = {
          displayName,
          name,
          address,
          lat,
          lng,
          source: 'wxChooseLocation',
          coordinateAccuracy: 'userSelected',
          provider: 'wx.chooseLocation',
          updatedAtMs: Date.now()
        }

        this.setData({
          location,
          locationDisplay: getLocationDisplay(location, address)
        })
        this.markDirtyAndSave()
        wx.showToast({ title: '位置已选择', icon: 'success' })
      },
      fail: err => {
        const msg = String(err?.errMsg || '')
        if (msg.includes('cancel')) return
        console.error('选择位置失败：', err)
        wx.showToast({ title: '选择位置失败', icon: 'none' })
      },
      complete: () => {
        this.setData({ locationPicking: false })
      }
    })
  },

  onRegionChange(e) {
    this.setData({ regionIndex: e.detail.value })
    this.markDirty()
  },

  buildUpdateData() {
    const {
      address,
      location,
      bigregion,
      phone,
      regionIndex,
      customPriceNonCore,
      customPriceCore
    } = this.data

    const region = regionIndex == 0 ? 'US' : 'CN'
    const updateData = {
      wechatID: this.data.wechat || '',
      address: address || '',
      location: location && typeof location === 'object' ? location : {},
      bigregion: bigregion || '',
      name: this.data.name || '',
      avatarUrl: this.data.avatarUrl || '',
      zelleName: this.data.zelleName || '',
      zelleAccount: this.data.zelleAccount || '',
      carNumber: this.data.carNumber || '',
      carBrand: this.data.carBrand || '',
      carModel: this.data.carModel || '',
      customPrice: {
        fortLeeNonCore: customPriceNonCore || '',
        fortLeeCore: customPriceCore || ''
      }
    }

    if (!phone) {
      updateData.phone = ''
      updateData.region = region
    } else {
      const cnValid = region === 'CN' && /^1\d{10}$/.test(phone)
      const usValid = region === 'US' && /^\d{10}$/.test(phone)
      if (cnValid || usValid) {
        updateData.phone = phone
        updateData.region = region
      }
    }

    return updateData
  },

  getSavePayloadKey(updateData) {
    return JSON.stringify(updateData || this.buildUpdateData())
  },

  async saveToCloud(options = {}) {
    const { silent = false, waitForActive = false } = options

    if (this._savingProfile) {
      const currentKey = this.getSavePayloadKey()
      if (currentKey !== this._activePayloadKey) {
        this._saveQueued = true
      }
      if (waitForActive && this._activeSavePromise) {
        try {
          await this._activeSavePromise
        } catch (e) {}
        await new Promise(resolve => setTimeout(resolve, 0))
        return this.saveToCloud({ silent, waitForActive: false })
      }
      return true
    }

    const updateData = this.buildUpdateData()
    const payloadKey = this.getSavePayloadKey(updateData)
    if (!this.data.unsaved && payloadKey === this._lastSavedPayloadKey) {
      return true
    }

    this._savingProfile = true
    this._saveQueued = false
    this._activePayloadKey = payloadKey

    try {
      const savePromise = wx.cloud.callFunction({
        name: 'updateUser',
        data: updateData
      })
      this._activeSavePromise = savePromise
      const res = await savePromise
      const result = res.result || {}
      if (!result.ok) {
        if (!silent) wx.showToast({ title: result.errorMsg || '保存失败', icon: 'none' })
        return false
      }

      this._lastSavedPayloadKey = payloadKey
      const currentKey = this.getSavePayloadKey()
      const stillDirty = currentKey !== payloadKey || !!this._saveQueued
      this._saveQueued = false
      this.setData({ unsaved: stillDirty })
      if (stillDirty) {
        setTimeout(() => this.saveToCloud({ silent: true }), 0)
      }
      return true
    } catch (e) {
      console.error('updateUser 调用失败', e)
      if (!silent) {
        showDataError('保存失败', e, '个人资料保存到数据库失败，请稍后重试。')
      }
      return false
    } finally {
      this._savingProfile = false
      this._activeSavePromise = null
      this._activePayloadKey = null
    }
  }
})
