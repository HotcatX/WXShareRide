const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()

exports.main = async (event, context) => {
  const { type } = event // 传入 'Departure' 或 'Arrival'

  if (!type) {
    return { success: false, message: '缺少参数 type' }
  }

  try {
    const collection = db.collection(type)
    const res = await collection.get()

    if (!res.data || res.data.length === 0) {
      return { success: false, message: `集合 ${type} 为空` }
    }

    const record = res.data[0]
    const id = record._id
    delete record._id

    const addressList = Object.keys(record).map(key => record[key])

    return {
      success: true,
      id,
      addressList
    }

  } catch (error) {
    console.error('加载失败', error)
    return {
      success: false,
      message: '加载失败',
      error: error.message
    }
  }
}
