Component({
  options: {
    styleIsolation: 'isolated'
  },

  properties: {
    visible: { type: Boolean, value: false },
    notice: { type: Object, value: {} }
  },

  data: {
    imageFailed: false
  },

  observers: {
    'notice.id, notice.imageUrl': function () {
      this.setData({ imageFailed: false })
    },
    visible: function (visible) {
      if (visible) this.setData({ imageFailed: false })
    }
  },

  methods: {
    stopBubble: function () {},

    onClose: function (event) {
      if (!this.properties.visible) return
      var notice = this.properties.notice || {}
      var dataset = event.currentTarget.dataset || {}
      this.triggerEvent('close', {
        id: notice.id || '',
        source: dataset.source || 'close'
      })
    },

    onImageError: function () {
      this.setData({ imageFailed: true })
    },

    onPreviewImage: function () {
      var notice = this.properties.notice || {}
      var imageUrl = notice.imageUrl
      if (!this.properties.visible || this._previewing || this.data.imageFailed || typeof imageUrl !== 'string' || !imageUrl) return
      var component = this
      var showPreviewError = function () {
        wx.showToast({ title: '图片暂时无法打开，请稍后再试', icon: 'none' })
      }
      this._previewing = true
      this.triggerEvent('preview', { id: notice.id || '' })
      try {
        wx.previewImage({
          current: imageUrl,
          urls: [imageUrl],
          showmenu: true,
          fail: showPreviewError,
          complete: function () {
            component._previewing = false
          }
        })
      } catch (error) {
        this._previewing = false
        showPreviewError()
      }
    }
  }
})
