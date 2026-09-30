const { createHandler } = require('./bridge')
const { createCompatBridge } = require('./compat-bridge')
const { APPID } = require('./context')

function createBackendHandler({authority,getKey,transport}) {
  const login=createHandler({getKey}),server=createCompatBridge({getKey,transport})
  return (event,context)=>{
    // Public deployment metadata only; no login, identity, database or secret.
    if(event&&event.action==='authority') {
      const fields=Object.keys(event).filter(key=>!['userInfo','tcbContext'].includes(key))
      if(fields.length!==1||authority!=='server')return Promise.resolve({ok:false,error:{code:'AUTHORITY_NOT_READY',status:503,message:'服务连接尚未确认'}})
      return Promise.resolve({ok:true,data:{appId:APPID,authority}})
    }
    if(event&&Object.hasOwn(event,'expectedAuthority')) {
      if(event.expectedAuthority!=='server'||authority!=='server')return Promise.resolve({ok:false,error:{code:'AUTHORITY_NOT_READY',status:503,message:'操作暂未完成，请重试'}})
      event={...event};delete event.expectedAuthority
    }
    // Keep authority metadata readable by released clients, but an old or
    // invalid deployment choice must never reopen the retired database writer.
    if(authority!=='server')return Promise.resolve({ok:false,error:{code:'OPERATION_UNAVAILABLE',status:503,message:'操作暂未完成，请重试'}})
    if(event&&event.action==='login')return login(event,context)
    return server(event,context)
  }
}
module.exports={createBackendHandler}
