const defaultAvatarUrl = 'https://mmbiz.qpic.cn/mmbiz/icTdbqWNOwNRna42FI242Lcia07jQodd2FJGIYQfG0LAJGFxM4FbnQP6yfMxBgJ0F3YRqJCJ1aPAK2dQagdusBZg/0'
const { showDataError } = require('../../../utils/error')
const {
  DEFAULT_CITY_TREE,
  normalizeCityTree,
  getCitySnapshot,
  getCountryTabs,
  getCountryGroups,
  cityGroupsHaveResults
} = require('../../../utils/cityTree')
const {
  ALL_AREA_LABEL,
  DEFAULT_REGION_TREE,
  normalizeRegionTree,
  findState,
  buildAreaSections,
  readCachedRegionTree,
  writeCachedRegionTree
} = require('../../../utils/regionTree')

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

const INITIAL_CITY_TREE = normalizeCityTree(DEFAULT_CITY_TREE)
const INITIAL_REGION_TREE = normalizeRegionTree(DEFAULT_REGION_TREE)
const CITY_PICKER_HINT = '选择你常用发布和交易的城市，下一步选择城市下的小区域。'
const AREA_PICKER_HINT = '请选择城市下的小区域，用于二手和转租的区域标签。'
const MARKET_PROFILE_REGION_HANDOFF_KEY = 'market_profile_region_handoff_v1'
const CITY_STATE_BY_KEY = {
  ny_nj: 'NY_NJ',
  ny: 'NY_NJ',
  nj: 'NY_NJ',
  boston: 'MA',
  philadelphia: 'PA',
  dc: 'DC',
  la: 'CA',
  bay_area: 'CA',
  seattle: 'WA',
  san_diego: 'CA',
  chicago: 'IL',
  ann_arbor: 'MI',
  champaign: 'IL',
  columbus: 'OH',
  dallas: 'TX',
  houston: 'TX',
  atlanta: 'GA',
  miami: 'FL',
  orlando: 'FL',
  austin: 'TX',
  other_city: 'OTHER'
}

function normalizeProfileCityKey(key = '') {
  const text = normalizeText(key).toLowerCase()
  if (['ny', 'nj', 'nyc', 'new york', 'new jersey', 'jersey', '纽约', '新泽西'].includes(text)) return 'ny_nj'
  return normalizeText(key)
}

function getCityStateKey(cityKey = '') {
  const key = normalizeProfileCityKey(cityKey)
  return CITY_STATE_BY_KEY[key] || key.toUpperCase()
}

function buildRegionDisplayParts(cityLabel, areaLabel, buildingName = '') {
  return [cityLabel, areaLabel, buildingName].map(normalizeText).filter(Boolean).join(' / ')
}

function markMarketProfileRegionHandoff(updateData = {}) {
  try {
    wx.setStorageSync(MARKET_PROFILE_REGION_HANDOFF_KEY, {
      ts: Date.now(),
      cityKey: normalizeText(updateData.cityKey),
      cityLabel: normalizeText(updateData.cityLabel),
      bigregion: normalizeText(updateData.bigregion),
      buildingName: normalizeText(updateData.buildingName),
      regionState: normalizeText(updateData.regionState),
      regionArea: normalizeText(updateData.regionArea),
      regionKey: normalizeText(updateData.regionKey),
      regionDisplay: normalizeText(updateData.regionDisplay),
      location: updateData.location && typeof updateData.location === 'object' ? updateData.location : {}
    })
  } catch (e) {}
}

function buildCityPickerGroups(tree, countryCode, activeCityKey, keyword = '') {
  return getCountryGroups(tree, countryCode || 'US', normalizeProfileCityKey(activeCityKey) || 'ny_nj', {
    includeAll: false,
    keyword
  })
}

function isImplicitAllArea(area = {}, stateKey = '') {
  const key = normalizeText(area.key).toLowerCase()
  return !!stateKey && key === `${normalizeText(stateKey).toLowerCase()}_all`
}

function normalizeAreaOption(area = {}, stateKey = '', activeAreaKey = '') {
  const key = normalizeText(area.key)
  const label = isImplicitAllArea(area, stateKey) ? ALL_AREA_LABEL : normalizeText(area.label)
  return {
    ...area,
    key,
    label,
    className: key === activeAreaKey ? 'active' : ''
  }
}

function getAreaOptionsForCity(regionTree, cityKey = '', activeAreaKey = '') {
  const stateKey = getCityStateKey(cityKey)
  const state = findState(regionTree, stateKey)
  if (!state) {
    const key = stateKey ? `${stateKey.toLowerCase()}_all` : ''
    return key ? [{ key, label: ALL_AREA_LABEL, className: key === activeAreaKey ? 'active' : '' }] : []
  }
  return (state.areas || []).map(area => normalizeAreaOption(area, state.key, activeAreaKey)).filter(area => area.key && area.label)
}

function inferProfileCityKey(user = {}, location = {}) {
  const explicit = normalizeProfileCityKey(user.cityKey || location.cityKey)
  if (explicit) return explicit
  const stateKey = normalizeText(user.regionState || location.regionState).toUpperCase()
  if (stateKey === 'NY' || stateKey === 'NJ' || stateKey === 'NY_NJ') return 'ny_nj'
  const regionKey = normalizeText(user.regionKey || location.regionKey).toLowerCase()
  if (regionKey.startsWith('ny_') || regionKey.startsWith('nj_')) return 'ny_nj'
  return normalizeProfileCityKey(regionKey)
}

Page({
  data: {
    from: 'profile',

    // 原来 wechat1 / wechat2 合并为一个字段
    wechat: '',
    address: '',
    location: {},
    locationDisplay: '',

    // 所住区域（存到 userInfo.bigregion + 结构化区域字段）
    bigregion: '',
    regionCityKey: '',
    regionCityLabel: '',
    regionStateKey: '',
    regionAreaKey: '',
    regionStateLabel: '',
    regionAreaLabel: '',
    regionDisplay: '',
    buildingName: '',
    locationPicking: false,
    cityTree: INITIAL_CITY_TREE,
    regionTree: INITIAL_REGION_TREE,
    cityPickerVisible: false,
    cityCountryTabs: getCountryTabs(INITIAL_CITY_TREE, 'US'),
    cityPickerGroups: buildCityPickerGroups(INITIAL_CITY_TREE, 'US', ''),
    activeCityCountryCode: 'US',
    citySearchKeyword: '',
    cityPickerHasResults: true,
    cityPickerEmptyText: '没有找到相关城市',
    cityPickerHintText: CITY_PICKER_HINT,
    areaPickerVisible: false,
    areaPickerTitle: '选择区域',
    areaOptions: [],
    areaSections: [],
    areaPickerHintText: AREA_PICKER_HINT,

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

    this.loadUserInfo()
    this.loadCityTreeFromCloud({ silent: true })
    this.loadRegionTreeFromCloud({ silent: true })
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
        const cityKey = inferProfileCityKey(user, location)
        const city = cityKey ? getCitySnapshot(this.data.cityTree || DEFAULT_CITY_TREE, cityKey) : null
        const cityLabel = city?.key === 'ny_nj'
          ? city.label
          : normalizeText(user.cityLabel || location.cityLabel || city?.label)
        const rawAreaKey = normalizeText(user.regionKey || location.regionKey)
        const rawAreaLabel = normalizeText(user.regionArea || location.regionArea || location.areaLabel)
        const areaKey = rawAreaKey && rawAreaKey !== cityKey ? rawAreaKey : ''
        const areaLabel = areaKey ? (areaKey.toLowerCase().endsWith('_all') ? ALL_AREA_LABEL : rawAreaLabel) : ''
        const stateKey = normalizeText(user.regionState || location.regionState) || getCityStateKey(cityKey)
        const buildingName = normalizeText(user.buildingName || location.buildingName)
        const regionBase = cityKey && cityLabel ? buildRegionDisplayParts(cityLabel, areaLabel) : ''

        this.setData({
          wechat: user.wechatID || '',
          address: buildingName,
          location,
          locationDisplay: hasLatLng(location) ? getLocationDisplay(location, '') : '',
          bigregion: regionBase,
          regionCityKey: regionBase ? cityKey : '',
          regionCityLabel: regionBase ? cityLabel : '',
          regionStateKey: regionBase ? stateKey : '',
          regionAreaKey: regionBase ? areaKey : '',
          regionStateLabel: regionBase ? stateKey : '',
          regionAreaLabel: regionBase ? areaLabel : '',
          regionDisplay: regionBase,
          buildingName,

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
    if (field === 'buildingName' || field === 'address') {
      const baseDisplay = buildRegionDisplayParts(this.data.regionCityLabel, this.data.regionAreaLabel)
      this.setData({
        address: value,
        buildingName: value,
        regionDisplay: baseDisplay
      })
      this.markDirty()
      return
    }
    this.setData({ [field]: value })
    this.markDirty()
  },

  _applyCityTree(tree, options = {}) {
    const cityTree = normalizeCityTree(tree)
    const activeCountryCode = options.countryCode || this.data.activeCityCountryCode || 'US'
    const citySearchKeyword = typeof options.keyword === 'string' ? options.keyword : (this.data.citySearchKeyword || '')
    const activeCityKey = normalizeProfileCityKey(this.data.regionCityKey || 'ny_nj')
    const cityPickerGroups = buildCityPickerGroups(cityTree, activeCountryCode, activeCityKey, citySearchKeyword)
    this.setData({
      cityTree,
      activeCityCountryCode,
      cityCountryTabs: getCountryTabs(cityTree, activeCountryCode),
      cityPickerGroups,
      cityPickerHasResults: cityGroupsHaveResults(cityPickerGroups),
      citySearchKeyword
    })
  },

  async loadCityTreeFromCloud(options = {}) {
    const { silent = false } = options
    try {
      const db = wx.cloud.database()
      let docData = null
      try {
        const doc = await db.collection('cityTree').doc('default').get()
        docData = doc?.data || null
      } catch (e) {}

      if (!docData) {
        const res = await db.collection('cityTree').limit(1).get()
        docData = (res.data || [])[0] || null
      }

      const tree = normalizeCityTree(docData)
      if (!tree.length) throw new Error('cityTree 数据为空或格式错误')
      this._applyCityTree(tree)
      return tree
    } catch (e) {
      console.error('cityTree 加载失败：', e)
      this._applyCityTree(DEFAULT_CITY_TREE)
      if (!silent) wx.showToast({ title: '城市配置加载失败，已使用默认城市', icon: 'none' })
      return normalizeCityTree(DEFAULT_CITY_TREE)
    }
  },

  _applyRegionTree(tree) {
    const regionTree = normalizeRegionTree(tree)
    const activeAreaKey = this.data.regionAreaKey || ''
    const areaOptions = this.data.areaPickerVisible
      ? getAreaOptionsForCity(regionTree, this.data.regionCityKey || 'ny_nj', activeAreaKey)
      : this.data.areaOptions
    this.setData({
      regionTree,
      areaOptions,
      areaSections: buildAreaSections(areaOptions)
    })
  },

  async loadRegionTreeFromCloud(options = {}) {
    const { silent = false } = options
    const cached = readCachedRegionTree()
    if (cached) this._applyRegionTree(cached)

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

      const tree = normalizeRegionTree(docData)
      if (!tree.length) throw new Error('regionTree 数据为空或格式错误')
      writeCachedRegionTree(tree)
      this._applyRegionTree(tree)
      return tree
    } catch (e) {
      console.error('regionTree 加载失败：', e)
      this._applyRegionTree(cached || DEFAULT_REGION_TREE)
      if (!silent) wx.showToast({ title: '区域配置加载失败，已使用默认区域', icon: 'none' })
      return normalizeRegionTree(cached || DEFAULT_REGION_TREE)
    }
  },

  async onTapRegionPicker() {
    if (!this.data.cityTree.length) await this.loadCityTreeFromCloud()
    const cityPickerGroups = buildCityPickerGroups(
      this.data.cityTree || DEFAULT_CITY_TREE,
      this.data.activeCityCountryCode || 'US',
      this.data.regionCityKey || 'ny_nj',
      ''
    )
    this.setData({
      cityPickerVisible: true,
      citySearchKeyword: '',
      cityPickerGroups,
      cityPickerHasResults: cityGroupsHaveResults(cityPickerGroups)
    })
  },

  onCityPickerCancel() {
    this.setData({ cityPickerVisible: false, citySearchKeyword: '' })
  },

  onCitySearchInput(e) {
    const keyword = (e.detail && e.detail.value) || ''
    const cityPickerGroups = buildCityPickerGroups(
      this.data.cityTree || DEFAULT_CITY_TREE,
      this.data.activeCityCountryCode || 'US',
      this.data.regionCityKey || 'ny_nj',
      keyword
    )
    this.setData({
      citySearchKeyword: keyword,
      cityPickerGroups,
      cityPickerHasResults: cityGroupsHaveResults(cityPickerGroups)
    })
  },

  onSelectCityCountry(e) {
    const code = e.currentTarget.dataset.code || 'US'
    const cityPickerGroups = buildCityPickerGroups(
      this.data.cityTree || DEFAULT_CITY_TREE,
      code,
      this.data.regionCityKey || 'ny_nj',
      this.data.citySearchKeyword || ''
    )
    this.setData({
      activeCityCountryCode: code,
      cityCountryTabs: getCountryTabs(this.data.cityTree || DEFAULT_CITY_TREE, code),
      cityPickerGroups,
      cityPickerHasResults: cityGroupsHaveResults(cityPickerGroups)
    })
  },

  onSelectCity(e) {
    const key = normalizeProfileCityKey(e.currentTarget.dataset.key || '')
    if (!key) return
    const city = getCitySnapshot(this.data.cityTree || DEFAULT_CITY_TREE, key)
    if (!city || city.key === 'all') return

    const cityKey = normalizeProfileCityKey(city.key)
    const cityLabel = city.label
    const stateKey = getCityStateKey(cityKey)
    const areaOptions = getAreaOptionsForCity(this.data.regionTree || DEFAULT_REGION_TREE, cityKey, '')
    this.setData({
      bigregion: cityLabel,
      regionCityKey: cityKey,
      regionCityLabel: cityLabel,
      regionStateKey: stateKey,
      regionAreaKey: '',
      regionStateLabel: stateKey,
      regionAreaLabel: '',
      regionDisplay: cityLabel,
      cityPickerVisible: false,
      citySearchKeyword: '',
      areaPickerTitle: `选择${cityLabel}区域`,
      areaOptions,
      areaSections: buildAreaSections(areaOptions),
      areaPickerVisible: areaOptions.length > 1
    })
    if (areaOptions.length <= 1 && areaOptions[0]) {
      this.applyAreaSelection(areaOptions[0])
      return
    }
    if (areaOptions.length > 1) wx.showToast({ title: '请选择具体区域', icon: 'none' })
  },

  onAreaPickerCancel() {
    this.setData({ areaPickerVisible: false })
  },

  onSelectProfileArea(e) {
    const key = normalizeText(e.currentTarget.dataset.key)
    if (!key) return
    const area = (this.data.areaOptions || []).find(item => item.key === key)
    if (!area) return
    this.applyAreaSelection(area)
  },

  applyAreaSelection(area = {}) {
    const areaKey = normalizeText(area.key)
    const areaLabel = normalizeText(area.label)
    if (!areaKey || !areaLabel) return
    const cityLabel = normalizeText(this.data.regionCityLabel)
    const baseDisplay = buildRegionDisplayParts(cityLabel, areaLabel)
    const areaOptions = (this.data.areaOptions || []).map(item => ({
      ...item,
      className: item.key === areaKey ? 'active' : ''
    }))
    this.setData({
      bigregion: baseDisplay,
      regionAreaKey: areaKey,
      regionAreaLabel: areaLabel,
      regionDisplay: baseDisplay,
      areaPickerVisible: false,
      areaOptions,
      areaSections: buildAreaSections(areaOptions)
    })
    this.markDirtyAndSave()
  },

  stopTouchMove() {},

  _getCurrentRegionSelection() {
    if (!this.data.regionCityKey || !this.data.regionCityLabel || !this.data.regionAreaKey || !this.data.regionAreaLabel) return null
    return {
      cityKey: this.data.regionCityKey,
      cityLabel: this.data.regionCityLabel,
      stateKey: this.data.regionStateKey || getCityStateKey(this.data.regionCityKey),
      stateLabel: this.data.regionStateLabel || this.data.regionStateKey || getCityStateKey(this.data.regionCityKey),
      areaKey: this.data.regionAreaKey,
      areaLabel: this.data.regionAreaLabel,
      buildingName: normalizeText(this.data.buildingName)
    }
  },

  _getCurrentRegionMeta() {
    const selection = this._getCurrentRegionSelection()
    if (!selection) {
      return {
        baseDisplay: '',
        fullDisplay: '',
        cityKey: '',
        cityLabel: '',
        stateKey: '',
        stateLabel: '',
        areaKey: '',
        areaLabel: '',
        buildingName: normalizeText(this.data.buildingName)
      }
    }

    const buildingName = normalizeText(this.data.buildingName)
    return {
      baseDisplay: buildRegionDisplayParts(selection.cityLabel, selection.areaLabel),
      fullDisplay: buildRegionDisplayParts(selection.cityLabel, selection.areaLabel, buildingName),
      cityKey: selection.cityKey,
      cityLabel: selection.cityLabel,
      stateKey: selection.stateKey,
      stateLabel: selection.stateLabel,
      areaKey: selection.areaKey,
      areaLabel: selection.areaLabel,
      buildingName
    }
  },

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
          buildingName: this.data.buildingName || '',
          cityKey: this.data.regionCityKey || '',
          cityLabel: this.data.regionCityLabel || '',
          region: this._getCurrentRegionMeta().fullDisplay,
          regionState: this.data.regionStateKey || '',
          regionArea: this.data.regionAreaLabel || '',
          areaLabel: this.data.regionAreaLabel || '',
          regionKey: this.data.regionAreaKey || '',
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
      buildingName,
      regionCityKey,
      regionCityLabel,
      regionStateKey,
      regionAreaKey,
      regionStateLabel,
      regionAreaLabel,
      phone,
      regionIndex,
      customPriceNonCore,
      customPriceCore
    } = this.data

    const region = regionIndex == 0 ? 'US' : 'CN'
    const regionMeta = this._getCurrentRegionMeta()
    const locationPayload = location && typeof location === 'object'
      ? {
        ...location,
        buildingName: regionMeta.buildingName,
        cityKey: regionMeta.cityKey,
        cityLabel: regionMeta.cityLabel,
        region: regionMeta.fullDisplay,
        regionState: regionMeta.stateKey,
        regionArea: regionMeta.areaLabel,
        areaLabel: regionMeta.areaLabel,
        regionKey: regionMeta.areaKey
      }
      : {}
    const updateData = {
      wechatID: this.data.wechat || '',
      address: buildingName || address || '',
      location: locationPayload,
      cityKey: regionCityKey || regionMeta.cityKey,
      cityLabel: regionCityLabel || regionMeta.cityLabel,
      bigregion: regionMeta.baseDisplay || bigregion || '',
      buildingName: regionMeta.buildingName,
      regionState: regionStateKey || regionMeta.stateKey,
      regionArea: regionAreaLabel || regionMeta.areaLabel,
      regionKey: regionAreaKey || regionMeta.areaKey,
      regionDisplay: regionMeta.fullDisplay,
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
    if (this.data.from === 'marketPost') {
      markMarketProfileRegionHandoff(updateData)
    }
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
