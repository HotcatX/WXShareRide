Page({
  data: {
    url: ""
  },

  onLoad(options = {}) {
    const rawUrl = String(options.url || "").trim()
    let url = rawUrl
    try {
      url = decodeURIComponent(rawUrl)
    } catch (e) {}

    if (!/^https?:\/\//i.test(url)) {
      this.setData({ url: "" })
      return
    }

    this.setData({ url })
  }
})
