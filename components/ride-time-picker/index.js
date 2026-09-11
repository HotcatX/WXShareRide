const pad = value => String(value).padStart(2, '0')

function initialTime(value) {
  if (typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    return value.split(':').map(Number)
  }
  const now = new Date()
  return [now.getHours(), now.getMinutes()]
}

Component({
  options: {
    styleIsolation: 'isolated'
  },

  properties: {
    visible: { type: Boolean, value: false },
    value: { type: String, value: '' }
  },

  data: {
    hours: Array.from({ length: 24 }, (_, index) => pad(index)),
    minutes: Array.from({ length: 60 }, (_, index) => pad(index)),
    pickerValue: [0, 0],
    selectedTime: '00:00',
    isPicking: false
  },

  observers: {
    visible: function (visible) {
      if (visible && !this._wasVisible) {
        const pickerValue = initialTime(this.properties.value)
        this._settled = false
        this._picking = false
        this.setData({
          pickerValue,
          selectedTime: pickerValue.map(pad).join(':'),
          isPicking: false
        })
      }
      if (!visible) this._picking = false
      this._wasVisible = visible
    }
  },

  methods: {
    stopBubble: function () {},

    onPickStart: function () {
      if (!this.properties.visible || this._settled) return
      this._picking = true
      this.setData({ isPicking: true })
    },

    onPickEnd: function () {
      if (!this.properties.visible || this._settled) return
      this._picking = false
      this.setData({ isPicking: false })
    },

    onChange: function (event) {
      if (!this.properties.visible || this._settled) return
      const values = event && event.detail && event.detail.value
      if (!Array.isArray(values) || values.length !== 2) return
      const [hour, minute] = values
      if (!Number.isInteger(hour) || hour < 0 || hour > 23 ||
          !Number.isInteger(minute) || minute < 0 || minute > 59) return
      this.setData({
        pickerValue: [hour, minute],
        selectedTime: `${pad(hour)}:${pad(minute)}`
      })
    },

    onCancel: function () {
      if (!this.properties.visible || this._settled) return
      this._settled = true
      this.triggerEvent('cancel')
    },

    onConfirm: function () {
      if (!this.properties.visible || this._settled || this._picking) return
      this._settled = true
      this.triggerEvent('confirm', { value: this.data.selectedTime })
    }
  }
})
