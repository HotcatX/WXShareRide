const { normalizeRidePlace, placeIdentity, resolvePlaceId } = require('../../utils/ridePlaceOptions')

function fixedEntries(values) {
  const seen = new Set()
  return (Array.isArray(values) ? values : []).reduce((entries, item) => {
    const value = normalizeRidePlace(typeof item === 'string' ? item : item && item.value)
    const label = normalizeRidePlace(typeof item === 'string' ? item : item && item.label) || value
    const key = placeIdentity(value)
    if (!value || ['其他', '自选'].includes(value) || seen.has(key)) return entries
    seen.add(key)
    entries.push({ label, value, key, placeId: resolvePlaceId(value), source: 'fixed' })
    return entries
  }, [])
}

Component({
  options: { styleIsolation: 'isolated' },
  properties: {
    visible: { type: Boolean, value: false },
    title: { type: String, value: '选择地点' },
    value: { type: String, value: '' },
    options: { type: Array, value: [] },
    fixedOptions: { type: Array, value: ['Fort Lee', '哥大'] },
    loading: { type: Boolean, value: false },
    error: { type: String, value: '' }
  },
  data: {
    fixedEntries: [],
    suggestions: [],
    keyword: '',
    customVisible: false,
    customValue: '',
    customError: '',
    canConfirmCustom: false,
    canUseSearch: false
  },
  observers: {
    visible: function (visible) {
      if (!visible) { this.stopObserving(); return }
      this._initialPresentation = false
      this.setData({ keyword: '', customVisible: false, customValue: '', customError: '', canConfirmCustom: false })
      this.refreshOptions()
    },
    'options, fixedOptions, value': function () { this.refreshOptions() }
  },
  lifetimes: { attached() { this.refreshOptions() }, detached() { this.stopObserving() } },
  methods: {
    stopBubble() {},
    refreshOptions() {
      const selected = placeIdentity(this.properties.value)
      const fixed = fixedEntries(this.properties.fixedOptions).slice(0, 20)
      const excluded = new Set(fixed.map(entry => entry.key))
      const keyword = normalizeRidePlace(this.data.keyword).toLowerCase()
      const seen = new Set(excluded)
      const suggestions = (Array.isArray(this.properties.options) ? this.properties.options : []).reduce((rows, item) => {
        const value = normalizeRidePlace(typeof item === 'string' ? item : item && (item.value || item.label))
        const key = placeIdentity(value)
        if (!value || seen.has(key)) return rows
        seen.add(key)
        if (keyword && !value.toLowerCase().includes(keyword) && !key.includes(placeIdentity(keyword))) return rows
        const source = item && ['personal', 'circle', 'city', 'new'].includes(item.source) ? item.source : 'personal'
        const id = typeof item === 'object' && item.placeId || resolvePlaceId(value)
        rows.push({ value, label: typeof item === 'object' && item.label || value, source,
          placeId: id === 'unknown' ? 'custom' : id,
          groupLabel: { personal: '我的最近', circle: '同圈常用', city: '本区常用', new: '新公共地点' }[source],
          selected: key === selected })
        return rows
      }, []).slice(0, Math.max(0, Math.min(12, 20 - fixed.length)))
      this.setData({
        fixedEntries: fixed.map((entry, position) => ({ ...entry, position, placeId: entry.placeId === 'unknown' ? 'custom' : entry.placeId, selected: entry.key === selected })),
        suggestions: suggestions.map((entry, index) => ({ ...entry, position: fixed.length + index, showGroup: !index || suggestions[index - 1].source !== entry.source })),
        canUseSearch: !!keyword && suggestions.length === 0
      }, () => {
        if (this.properties.visible && !this._initialPresentation) {
          this._initialPresentation = true
          this.present('rendered')
          this.observeVisible()
        }
      })
    },
    present(stage = 'rendered', items) {
      if (this.properties.visible) this.triggerEvent('presentation', { stage, items: items || this.data.fixedEntries.concat(this.data.suggestions) })
    },
    stopObserving() { if (this._placeObserver) { try { this._placeObserver.disconnect() } catch (_) {} }; this._placeObserver = null },
    observeVisible() {
      this.stopObserving()
      if (typeof this.createIntersectionObserver !== 'function') return
      this._visiblePlaces = new Set()
      try {
        this._placeObserver = this.createIntersectionObserver({ observeAll: true, thresholds: [0, 0.5] })
        this._placeObserver.relativeToViewport().observe('.place-observed', result => {
          if (!this.properties.visible || result.intersectionRatio < 0.5) return
          const row = result.dataset || {}, position = Number(row.position), key = position + ':' + row.placeId
          if (!row.placeId || !Number.isInteger(position) || this._visiblePlaces.has(key)) return
          this._visiblePlaces.add(key)
          this.present('visible', [{ placeId: row.placeId, position, source: row.source }])
        })
      } catch (_) {}
    },
    onCancel() {
      this.stopObserving()
      if (this.properties.visible) this.triggerEvent('cancel')
    },
    onSelect(event) {
      if (!this.properties.visible) return
      const value = normalizeRidePlace(event.currentTarget.dataset.value)
      const allowed = this.data.fixedEntries.concat(this.data.suggestions)
      const selected = allowed.find(entry => entry.value === value)
      if (selected) { this.present(); this.triggerEvent('confirm', { ...selected, value }); this.stopObserving() }
    },
    onSearch(event) {
      this.setData({ keyword: String(event.detail.value || '').slice(0, 200) })
      this.refreshOptions()
    },
    onOpenCustom() {
      if (!this.properties.visible) return
      const fixed = this.data.fixedEntries.some(entry => entry.key === placeIdentity(this.properties.value))
      const value = normalizeRidePlace(this.data.keyword) || (!fixed ? normalizeRidePlace(this.properties.value) : '')
      this.setData({ customVisible: true, customValue: value, customError: '', canConfirmCustom: !!value })
    },
    onCloseCustom() { this.triggerEvent('customcancel'); this.setData({ customVisible: false, customError: '' }) },
    onCustomInput(event) {
      const value = String(event.detail.value || '').slice(0, 200)
      this.setData({ customValue: value, customError: '', canConfirmCustom: !!normalizeRidePlace(value) })
    },
    confirmValue(raw) {
      if (!this.properties.visible) return
      const value = normalizeRidePlace(raw)
      if (!value) {
        this.setData({ customError: '请填写地点，最多 200 字' })
        return
      }
      // A typed alias of a common place still uses its configured price key.
      const fixed = this.data.fixedEntries.concat(this.data.suggestions).find(entry => placeIdentity(entry.value) === placeIdentity(value))
      this.present()
      this.triggerEvent('confirm', { value: fixed ? fixed.value : value, placeId: fixed ? fixed.placeId : 'custom', source: fixed ? fixed.source : 'custom', position: fixed ? fixed.position : this.data.fixedEntries.length + this.data.suggestions.length, custom: true })
      this.stopObserving()
    },
    onConfirmCustom() { this.confirmValue(this.data.customValue) },
    onUseSearch() {
      if (this.data.canUseSearch) this.confirmValue(this.data.keyword)
    },
    onRetry() {
      if (this.properties.visible && !this.properties.loading) this.triggerEvent('retry')
    }
  }
})
