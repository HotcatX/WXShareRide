const { createHandler } = require('./bridge')
const { createCompatHandler } = require('./compat')
const { createCompatBridge } = require('./compat-bridge')

function createBackendHandler({authority,getKey,getDb,transport}) {
  const login=createHandler({getKey}),cloud=createCompatHandler({getDb}),server=createCompatBridge({getKey,transport})
  return (event,context)=>{
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
