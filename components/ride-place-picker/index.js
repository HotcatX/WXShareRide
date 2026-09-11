const { normalizeRidePlace, uniqueRidePlaces, placeIdentity } = require('../../utils/ridePlaceOptions')

function fixedEntries(values) {
  const seen = new Set()
  return (Array.isArray(values) ? values : []).reduce((entries, item) => {
    const value = normalizeRidePlace(typeof item === 'string' ? item : item && item.value)
    const label = normalizeRidePlace(typeof item === 'string' ? item : item && item.label) || value
    const key = placeIdentity(value)
    if (!value || ['其他', '自选'].includes(value) || seen.has(key)) return entries
    seen.add(key)
    entries.push({ label, value, key })
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
      if (!visible) return
      this.setData({ keyword: '', customVisible: false, customValue: '', customError: '', canConfirmCustom: false })
      this.refreshOptions()
    },
    'options, fixedOptions, value': function () { this.refreshOptions() }
  },
  lifetimes: { attached() { this.refreshOptions() } },
  methods: {
    stopBubble() {},
    refreshOptions() {
      const selected = placeIdentity(this.properties.value)
      const fixed = fixedEntries(this.properties.fixedOptions)
      const excluded = new Set(fixed.map(entry => entry.key))
      const keyword = normalizeRidePlace(this.data.keyword).toLowerCase()
      const suggestions = uniqueRidePlaces(this.properties.options)
        .filter(value => !excluded.has(placeIdentity(value)))
        .filter(value => !keyword || value.toLowerCase().includes(keyword) || placeIdentity(value).includes(placeIdentity(keyword)))
        .map(value => ({ value, selected: placeIdentity(value) === selected }))
      this.setData({
        fixedEntries: fixed.map(entry => ({ ...entry, selected: entry.key === selected })),
        suggestions,
        canUseSearch: !!keyword && suggestions.length === 0
      })
    },
    onCancel() {
      if (this.properties.visible) this.triggerEvent('cancel')
    },
    onSelect(event) {
      if (!this.properties.visible) return
      const value = normalizeRidePlace(event.currentTarget.dataset.value)
      const allowed = this.data.fixedEntries.concat(this.data.suggestions)
      if (value && allowed.some(entry => entry.value === value)) this.triggerEvent('confirm', { value })
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
    onCloseCustom() { this.setData({ customVisible: false, customError: '' }) },
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
      const fixed = this.data.fixedEntries.find(entry => entry.key === placeIdentity(value))
      this.triggerEvent('confirm', { value: fixed ? fixed.value : value })
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
