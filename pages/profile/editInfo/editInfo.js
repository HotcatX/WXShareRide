const defaultAvatarUrl = 'https://mmbiz.qpic.cn/mmbiz/icTdbqWNOwNRna42FI242Lcia07jQodd2FJGIYQfG0LAJGFxM4FbnQP6yfMxBgJ0F3YRqJCJ1aPAK2dQagdusBZg/0'
const { showDataError } = require('../../../utils/error')
const {
  DEFAULT_REGION_TREE,
  normalizeRegionTree,
  loadRegionTreeConfig,
  readCachedRegionTree,
  writeCachedRegionTree,
  getCityOptions,
  getCitySnapshot,
  getGroupOptions,
  getAreaOptions,
  findState
} = require('../../../utils/Region')

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

const INITIAL_REGION_TREE = normalizeRegionTree(DEFAULT_REGION_TREE)
// const CITY_PICKER_HINT = '请选择您所在的地区'
// const AREA_PICKER_HINT = '请选择您所在的区域'
const MARKET_PROFILE_REGION_HANDOFF_KEY = 'market_profile_region_handoff_v1'

function normalizeProfileCityKey(key = '') {
  return normalizeText(key).toUpperCase()
}

function buildRegionDisplayParts(stateLabel, groupLabel, areaLabel, buildingName = '') {
  return [stateLabel, groupLabel, areaLabel, buildingName]
    .map(normalizeText)
    .filter(Boolean)
    .join(' / ')
}

function buildCityPickerGroups(tree, activeCityKey = '', keyword = '') {
  const kw = normalizeText(keyword).toLowerCase()
  const activeKey = normalizeProfileCityKey(activeCityKey)

  const cities = getCityOptions(tree)
    .filter(city => {
      if (!kw) return true
      return [city.key, city.label]
        .map(v => normalizeText(v).toLowerCase())
        .some(v => v.includes(kw))
    })
    .map(city => ({
      ...city,
      className: normalizeProfileCityKey(city.key) === activeKey ? 'active' : ''
    }))

  return [
    {
      title: '',
      badge: '',
      cities
    }
  ].filter(group => group.cities.length)
}

function cityGroupsHaveResults(groups = []) {
  return groups.some(group => Array.isArray(group.cities) && group.cities.length)
}

function buildAreaUiPatch(tree, stateKey = '', activeGroupKey = '', activeAreaKey = '') {
  const state = findState(tree, stateKey)
  const rawGroups = state && Array.isArray(state.groups) ? state.groups : []

  const selectedGroupKey = activeGroupKey || (rawGroups[0] && rawGroups[0].key) || ''

  const groups = rawGroups.map(group => ({
    key: group.key,
    label: group.label || group.key,
    className: group.key === selectedGroupKey ? 'active' : ''
  }))

  const selectedGroup = rawGroups.find(group => group.key === selectedGroupKey)
  const areas = selectedGroup && Array.isArray(selectedGroup.areas)
    ? selectedGroup.areas.map(area => {
        const key = typeof area === 'object' ? normalizeText(area.key || area.label) : normalizeText(area)
        const label = typeof area === 'object' ? normalizeText(area.label || area.key) : normalizeText(area)
        return {
          key,
          label,
          className: key === activeAreaKey ? 'active' : ''
        }
      }).filter(item => item.key && item.label)
    : []

  return {
    areaGroupOptions: groups,
    activeAreaGroupKey: selectedGroupKey,
    activeAreaGroupLabel: selectedGroup ? (selectedGroup.label || selectedGroup.key) : '',
    areaOptions: areas
  }
}

function inferProfileCityKey(user = {}, location = {}) {
  return normalizeProfileCityKey(
    user.cityKey ||
    user.regionState ||
    location.cityKey ||
    location.regionState
  )
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

    regionTree: INITIAL_REGION_TREE,
    cityPickerVisible: false,
    cityPickerGroups: buildCityPickerGroups(INITIAL_REGION_TREE, ''),
    citySearchKeyword: '',
    cityPickerHasResults: true,
    cityPickerEmptyText: '没有找到相关地区',
    // cityPickerHintText: CITY_PICKER_HINT,

    areaPickerVisible: false,
    areaPickerTitle: '选择区域',
    areaGroupOptions: [],
    activeAreaGroupKey: '',
    areaOptions: [],
    // areaPickerHintText: AREA_PICKER_HINT,

    regionGroupKey: '',
    regionGroupLabel: '',

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

  goBack() {
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
    this.loadRegionTreeFromCloud({ silent: true })
  },

  onHide() {

  },

  onUnload() {
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
        const city = cityKey ? getCitySnapshot(this.data.regionTree || DEFAULT_REGION_TREE, cityKey) : null
        const cityLabel = normalizeText(user.cityLabel || location.cityLabel || city?.label || cityKey)
        const groupKey = normalizeText(user.regionCounty || user.regionGroup || location.regionCounty || location.regionGroup)
        const groupLabel = groupKey
        const buildingName = normalizeText(user.Apartment || user.buildingName || user.address || location.buildingName)

        const stateLabel = normalizeText(user.regionState)
        const countyLabel = normalizeText(user.regionCounty)
        const areaLabel = normalizeText(user.regionArea)

        const regionBase = cityKey
          ? buildRegionDisplayParts(cityLabel, groupLabel, areaLabel)
          : ''
        const stateKey = normalizeText(user.regionState || location.regionState || cityKey)

        this.setData({
          wechat: user.wechatID || '',
          address: buildingName,
          location,
          locationDisplay: hasLatLng(location) ? getLocationDisplay(location, '') : '',
          
          bigregion: regionBase,
          regionStateLabel: stateLabel,
          regionGroupLabel: countyLabel,
          regionAreaLabel: areaLabel,

          regionStateKey: stateLabel,
          regionGroupKey: countyLabel,
          regionAreaKey: areaLabel,
          regionDisplay: regionBase,
          buildingName,

          phone: user.phone || '',
          regionIndex: (user.regionPhone === 'CN') ? 1 : 0,
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
      const baseDisplay = buildRegionDisplayParts(
        this.data.regionCityLabel,
        this.data.regionGroupLabel,
        this.data.regionAreaLabel
      )
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

  _applyRegionTree(tree) {
    const regionTree = normalizeRegionTree(tree)
    const cityPickerGroups = buildCityPickerGroups(
      regionTree,
      this.data.regionCityKey || '',
      this.data.citySearchKeyword || ''
    )
  
    const areaPatch = this.data.regionCityKey
      ? buildAreaUiPatch(
          regionTree,
          this.data.regionCityKey,
          this.data.regionGroupKey,
          this.data.regionAreaKey
        )
      : {}
  
    this.setData({
      regionTree,
      cityPickerGroups,
      cityPickerHasResults: cityGroupsHaveResults(cityPickerGroups),
      ...areaPatch
    })
  },

  async loadRegionTreeFromCloud(options = {}) {
    if (!options.force) {
      const cached = readCachedRegionTree()
      if (cached) {
        const tree = normalizeRegionTree(cached)
        this._applyRegionTree(tree)
        return tree
      }
    }
  
    try {
      const { tree, fromCloud } = await loadRegionTreeConfig({ useCache: false })
      const normalized = normalizeRegionTree(tree)
  
      if (fromCloud) writeCachedRegionTree(normalized)
  
      this._applyRegionTree(normalized)
      return normalized
    } catch (e) {
      console.error('REGION_TREE 加载失败：', e)
      const fallback = normalizeRegionTree(DEFAULT_REGION_TREE)
      this._applyRegionTree(fallback)
      return fallback
    }
  },

  async onTapRegionPicker() {
    if (!this.data.regionTree.length) {
      await this.loadRegionTreeFromCloud()
    }
  
    const cityPickerGroups = buildCityPickerGroups(
      this.data.regionTree || DEFAULT_REGION_TREE,
      this.data.regionCityKey || '',
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
      this.data.regionTree || DEFAULT_REGION_TREE,
      this.data.regionCityKey || '',
      keyword
    )
  
    this.setData({
      citySearchKeyword: keyword,
      cityPickerGroups,
      cityPickerHasResults: cityGroupsHaveResults(cityPickerGroups)
    })
  },

  onSelectCity(e) {
    const key = normalizeProfileCityKey(e.currentTarget.dataset.key || '')
    if (!key) return
  
    const city = getCitySnapshot(this.data.regionTree || DEFAULT_REGION_TREE, key)
    if (!city) return
  
    const cityKey = city.key
    const cityLabel = city.label || city.key
  
    const areaPatch = buildAreaUiPatch(
      this.data.regionTree || DEFAULT_REGION_TREE,
      cityKey,
      '',
      ''
    )
  
    this.setData({
      bigregion: cityLabel,
      regionCityKey: cityKey,
      regionCityLabel: cityLabel,
      regionStateKey: cityKey,
      regionStateLabel: cityLabel,
  
      regionGroupKey: areaPatch.activeAreaGroupKey || '',
      regionGroupLabel: areaPatch.activeAreaGroupLabel || '',
      regionAreaKey: '',
      regionAreaLabel: '',
      regionDisplay: cityLabel,
  
      cityPickerVisible: false,
      citySearchKeyword: '',
  
      areaPickerTitle: `选择${cityLabel}区域`,
      areaPickerVisible: true,
  
      ...areaPatch
    })
  },

  onSelectProfileAreaGroup(e) {
    const key = normalizeText(e.currentTarget.dataset.key)
    if (!key) return
  
    const areaPatch = buildAreaUiPatch(
      this.data.regionTree || DEFAULT_REGION_TREE,
      this.data.regionCityKey,
      key,
      ''
    )
  
    this.setData({
      regionGroupKey: key,
      regionGroupLabel: areaPatch.activeAreaGroupLabel || key,
      regionAreaKey: '',
      regionAreaLabel: '',
      regionDisplay: buildRegionDisplayParts(
        this.data.regionCityLabel,
        areaPatch.activeAreaGroupLabel || key
      ),
      ...areaPatch
    })
  },

  onAreaPickerCancel() {
    this.setData({ areaPickerVisible: false })
  },

  // onSelectProfileAreaSection(e) {
  //   const key = normalizeText(e.currentTarget.dataset.key).toLowerCase()
  //   if (!key) return
  //   const areaOptions = this.data.areaOptions || []
  //   if (key === ALL_AREA_KEY) {
  //     const allArea = areaOptions.find(item => item.key === ALL_AREA_KEY) || { key: ALL_AREA_KEY, label: ALL_AREA_LABEL }
  //     this.applyAreaSelection(allArea)
  //     return
  //   }
  //   this.setData({
  //     ...buildProfileAreaUiPatch(areaOptions, this.data.regionAreaKey || '', key)
  //   })
  // },

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
    const groupLabel = normalizeText(this.data.regionGroupLabel || this.data.activeAreaGroupKey)
  
    const baseDisplay = buildRegionDisplayParts(cityLabel, groupLabel, areaLabel)
  
    const areaOptions = (this.data.areaOptions || []).map(item => ({
      ...item,
      className: item.key === areaKey ? 'active' : ''
    }))
  
    this.setData({
      bigregion: baseDisplay,
      regionGroupKey: this.data.activeAreaGroupKey || this.data.regionGroupKey,
      regionGroupLabel: groupLabel,
      regionAreaKey: areaKey,
      regionAreaLabel: areaLabel,
      regionDisplay: baseDisplay,
      areaPickerVisible: false,
      areaOptions
    })
  
    this.markDirtyAndSave()
  },

  stopTouchMove() {},

  _getCurrentRegionSelection() {
    if (!this.data.regionCityKey || !this.data.regionGroupKey || !this.data.regionAreaKey) return null
  
    return {
      cityKey: this.data.regionCityKey,
      cityLabel: this.data.regionCityLabel,
      stateKey: this.data.regionStateKey || this.data.regionCityKey,
      stateLabel: this.data.regionStateLabel || this.data.regionCityLabel,
      groupKey: this.data.regionGroupKey,
      groupLabel: this.data.regionGroupLabel,
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
        groupKey: '',
        groupLabel: '',
        areaKey: '',
        areaLabel: '',
        buildingName: normalizeText(this.data.buildingName)
      }
    }
  
    const buildingName = normalizeText(this.data.buildingName)
  
    return {
      baseDisplay: buildRegionDisplayParts(
        selection.cityLabel,
        selection.groupLabel,
        selection.areaLabel
      ),
      fullDisplay: buildRegionDisplayParts(
        selection.cityLabel,
        selection.groupLabel,
        selection.areaLabel,
        buildingName
      ),
      cityKey: selection.cityKey,
      cityLabel: selection.cityLabel,
      stateKey: selection.stateKey,
      stateLabel: selection.stateLabel,
      groupKey: selection.groupKey,
      groupLabel: selection.groupLabel,
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
          lng
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

  validateBeforeSave() {
    const wechat = String(this.data.wechat || '').trim()
    const phone = String(this.data.phone || '').trim()
    const region = this.data.regionIndex == 0 ? 'US' : 'CN'
  
    if (!wechat) {
      wx.showToast({
        title: '请填写微信号',
        icon: 'none'
      })
      return false
    }
  
    // if (!phone) {
    //   wx.showToast({
    //     title: '请填写手机号',
    //     icon: 'none'
    //   })
    //   return false
    // }
  
    const phoneValid = region === 'CN'
      ? /^1\d{10}$/.test(phone)
      : /^\d{10}$/.test(phone)
  
    if (!phoneValid) {
      wx.showToast({
        title: region === 'CN' ? '请输入正确的中国手机号' : '请输入10位美国手机号',
        icon: 'none'
      })
      return false
    }
  
    return true
  },
  
  async onSaveProfile() {
    if (!this.validateBeforeSave()) return
    if (this._savingProfile) return
  
    const ok = await this.saveToCloud({
      silent: false,
      waitForActive: true
    })
  
    if (!ok) return
  
    wx.showToast({
      title: '保存成功',
      icon: 'success',
      duration: 800
    })
  
    setTimeout(() => {
      wx.navigateBack()
    }, 800)
  },

  buildUpdateData() {
    const {
      regionGroupLabel,
      location,
      regionStateKey,
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
        displayName: normalizeText(location.displayName || location.name || location.address),
        name: normalizeText(location.name || location.displayName || location.address),
        address: normalizeText(location.address),
        lat: toFiniteNumber(location.lat ?? location.latitude),
        lng: toFiniteNumber(location.lng ?? location.longitude)
      }
    : {}
    const updateData = {
      wechatID: this.data.wechat || '',
      phone: phone || '',
      regionPhone: region,
      location: locationPayload,
    
      Apartment: regionMeta.buildingName,
      regionState: regionMeta.stateKey,
      regionCounty: regionMeta.groupLabel,
      regionArea: regionMeta.areaLabel,
    
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
