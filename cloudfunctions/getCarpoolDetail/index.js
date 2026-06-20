const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

exports.main = async (event, context) => {
  const { id } = event
  try {
    const db = cloud.database()
    const res = await db.collection('Carpool').doc(id).get()
    return { success: true, data: res.data}
  } catch (err) {
    console.error(err)
    return { success: false }
  }
}
