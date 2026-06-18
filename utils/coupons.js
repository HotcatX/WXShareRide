// utils/coupons.js

const ENV_ID = "test-8gd9an1je93136d4"
const BUCKET = "7465-test-8gd9an1je93136d4-1383643768"
const ROOT = `cloud://${ENV_ID}.${BUCKET}`

// ✅ 以后新增优惠券，只需要在这里加一条
// store 必须和云端文件名一致（不含后缀），默认 .png
const COUPONS = [
  {
    id: "c1",
    category: "food", // food -> restaurant
    tag1: "餐厅",
    tag2: "堂食",
    store: "Mala Mini",
    title: "Mala Mini -折扣优惠券",
    expireText: "01/20/2026前有效",
    discountText: "8.5折",
    note: "任意金额可用"
  },
  {
    id: "c2",
    category: "food",
    tag1: "餐厅",
    tag2: "堂食",
    store: "小串店",
    title: "小串店 -折扣优惠券",
    expireText: "01/20/2026前有效",
    discountText: "9折",
    note: "任意金额可用"
  },
  {
    id: "c3",
    category: "food",
    tag1: "餐厅",
    tag2: "堂食",
    store: "湘味苑",
    title: "湘味苑 -折扣优惠券",
    expireText: "01/20/2026前有效",
    discountText: "8.5折",
    note: "任意金额可用"
  },
  {
    id: "c4",
    category: "food",
    tag1: "餐厅",
    tag2: "堂食",
    store: "Green Dragon",
    title: "Green Dragon -折扣优惠券",
    expireText: "01/20/2026前有效",
    discountText: "9折",
    note: "任意金额可用"
  },
  {
    id: "c5",
    category: "fun", // fun -> entertainment
    tag1: "娱乐",
    tag2: "到店",
    store: "Edge Golf",
    title: "Edge Golf -折扣优惠券",
    expireText: "01/20/2026前有效",
    discountText: "立减10-20",
    note: "任意金额可用"
  },
  {
    id: "c6",
    category: "food",
    tag1: "餐厅",
    tag2: "堂食",
    store: "川天下",
    title: "川天下 -折扣优惠券",
    expireText: "01/20/2026前有效",
    discountText: "8.5折",
    note: "任意金额可用"
  }
]

function getCouponFileID(coupon) {
  if (!coupon || !coupon.store) return ""

  const sub = coupon.category === "fun" ? "entertainment" : "restaurant"
  const ext = coupon.ext || ".jpg" // 如果某张是 jpg，就在该条里加 ext: ".jpg"

  // cloud://ENV.BUCKET/coupons/restaurant/店名.png
  return `${ROOT}/coupons/${sub}/${coupon.store}/${coupon.store}${ext}`
}

async function resolveToTempURL(fileID) {
  if (!fileID) return ""
  if (/^https?:\/\//i.test(fileID)) return fileID

  if (typeof fileID === "string" && fileID.startsWith("cloud://")) {
    try {
      const res = await wx.cloud.getTempFileURL({ fileList: [fileID] })
      return res?.fileList?.[0]?.tempFileURL || ""
    } catch (e) {
      console.error("getTempFileURL failed:", e, fileID)
      return ""
    }
  }
  return fileID
}

module.exports = {
  COUPONS,
  getCouponFileID,
  resolveToTempURL
}
