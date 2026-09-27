const { createHandler } = require('./bridge')
const { createCompatHandler } = require('./compat')
const { createCompatBridge } = require('./compat-bridge')
const { APPID } = require('./context')

function createBackendHandler({authority,getKey,getDb,transport}) {
  const login=createHandler({getKey}),cloud=createCompatHandler({getDb}),server=createCompatBridge({getKey,transport})
  return (event,context)=>{
    // Public deployment metadata only; no login, identity, database or secret.
    if(event&&event.action==='authority') {
      const fields=Object.keys(event).filter(key=>!['userInfo','tcbContext'].includes(key))
      if(fields.length!==1||!['cloudbase','server'].includes(authority))return Promise.resolve({ok:false,error:{code:'AUTHORITY_NOT_READY',status:503,message:'服务连接尚未确认'}})
      return Promise.resolve({ok:true,data:{appId:APPID,authority}})
    }
    if(event&&Object.hasOwn(event,'expectedAuthority')) {
      if(event.expectedAuthority!=='server'||authority!=='server')return Promise.resolve({ok:false,error:{code:'AUTHORITY_NOT_READY',status:503,message:'操作暂未完成，请重试'}})
      event={...event};delete event.expectedAuthority
    }
    if(event&&event.action==='login')return login(event,context)
    if(authority==='cloudbase')return cloud(event,context)
    if(authority==='server')return server(event,context)
    return Promise.resolve({ok:false,error:{code:'OPERATION_UNAVAILABLE',status:503,message:'操作暂未完成，请重试'}})
  }
}
module.exports={createBackendHandler}
