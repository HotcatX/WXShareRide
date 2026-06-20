function normalizeErrorMessage(err) {
  if (!err) return ""
  if (typeof err === "string") return err
  return String(err.errMsg || err.message || err.errorMsg || err.errCode || "")
}

function showDataError(title, err, message) {
  const detail = normalizeErrorMessage(err)
  const content = [
    message || "数据加载失败，请稍后重试。",
    detail ? `\n错误信息：${detail}` : ""
  ].join("")

  wx.showModal({
    title: title || "数据错误",
    content,
    showCancel: false,
    confirmText: "知道了"
  })
}

module.exports = {
  normalizeErrorMessage,
  showDataError
}
