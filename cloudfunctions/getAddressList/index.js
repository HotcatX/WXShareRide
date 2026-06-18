// 云函数入口文件
const cloud = require('wx-server-sdk')

cloud.init({
  // 👇 建议加上你的环境 ID（在云开发控制台顶部可见）
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()

// 云函数入口函数
exports.main = async (event, context) => {
  const { type } = event // 传入 'Departure' 或 'Arrival'

  console.log('收到参数 type:', type)

  if (!type) {
    return { success: false, message: '缺少参数 type' }
  }

  try {
    const collection = db.collection(type)
    const res = await collection.get()

    console.log('数据库查询结果:', res)

    if (!res.data || res.data.length === 0) {
      return { success: false, message: `集合 ${type} 为空` }
    }

    // 假设只有一条记录
    const record = res.data[0]
    const id = record._id
    delete record._id

    // 提取所有字段名和值为地址选项
    const addressList = Object.keys(record).map(key => record[key])

    console.log('提取出的地址:', addressList)

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