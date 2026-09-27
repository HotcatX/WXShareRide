const crypto = require('crypto')
const https = require('https')
const { APPID, getIdentity } = require('./context')
const { READS, WRITES } = require('./compat')
const { record } = require('./receipts')
const PATH = '/internal/v1/compat/cloudbase', DOMAIN = 'linkx-compat-bridge-v1'
const ENDPOINT = 'https://collect.linkx.ink' + PATH
const unavailable = () => ({ok:false,error:{code:'OPERATION_UNAVAILABLE',status:503,message:'操作暂未完成，请重试'}})

function send(body, secret, { request = https.request, now = Date.now } = {}) {
  if (!Buffer.isBuffer(secret) || secret.length !== 32) return Promise.reject(Error('OPERATION_UNAVAILABLE'))
  const raw = JSON.stringify(body)
  if (Buffer.byteLength(raw)>69632) return Promise.reject(Error('OPERATION_UNAVAILABLE'))
  const key=crypto.createHmac('sha256',secret).update('linkx-compat-bridge-key-v1').digest()
  const timestamp=String(now()),nonce=crypto.randomBytes(16).toString('hex')
  const signature=crypto.createHmac('sha256',key).update(`${DOMAIN}\nPOST\n${PATH}\n${APPID}\n${timestamp}\n${nonce}\n${raw}`).digest('hex')
  return new Promise((resolve,reject)=>{
    let settled=false,req
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(deadline);if(error)reject(Error('OPERATION_UNAVAILABLE'));else resolve(value)}
    const deadline=setTimeout(()=>{finish(true);req?.destroy()},10000)
    try {
      req=request(ENDPOINT,{method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(raw),'Accept-Encoding':'identity',
        'X-Linkx-Compat-Timestamp':timestamp,'X-Linkx-Compat-Nonce':nonce,'X-Linkx-Compat-Signature':signature}},response=>{
        response.on('error',()=>finish(true));response.on('aborted',()=>finish(true))
        const length=response.headers['content-length'],encoding=response.headers['content-encoding']
        if(!Number.isInteger(response.statusCode)||response.statusCode<200||response.statusCode>599||
          encoding && (typeof encoding!=='string'||encoding.toLowerCase()!=='identity')||
          length!==undefined&&(typeof length!=='string'||!/^\d+$/.test(length)||Number(length)>2097152)) {finish(true);response.destroy();return}
        const chunks=[];let size=0
        response.on('data',chunk=>{size+=chunk.length;if(size>2097152){finish(true);response.destroy();return}chunks.push(chunk)})
        response.on('end',()=>{
          try {
            if(length!==undefined&&Number(length)!==size)throw Error()
            const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)))
            if(response.statusCode===200&&value.ok===true)finish(false,value)
            else if(response.statusCode>=400&&record(value.error)&&/^[A-Z0-9_]{1,80}$/.test(value.error.code))finish(false,{ok:false,error:{code:value.error.code,status:response.statusCode,message:'操作暂未完成，请重试'}})
            else finish(true)
          }catch(_){finish(true)}
        })
      });req.on('error',()=>finish(true));req.end(raw)
    }catch(_){finish(true);req?.destroy()}
  })
}
function createCompatBridge({getKey,transport=send}) {
  return async (event,context)=>{
    try {
      const identity=getIdentity(context)
      if(!identity||!record(event))return unavailable()
      const input=Object.fromEntries(Object.entries(event).filter(([key])=>!['userInfo','tcbContext'].includes(key)))
      if(Object.keys(input).some(key=>!['action','body','expectedOpenid','key'].includes(key))||input.expectedOpenid!==identity.openid||!record(input.body)||
        !READS.has(input.action)&&!WRITES.has(input.action)||WRITES.has(input.action)!==Object.hasOwn(input,'key'))return unavailable()
      const reply=await transport({purpose:'compat',appId:identity.appId,openid:identity.openid,source:identity.source,
        action:input.action,body:input.body,...(WRITES.has(input.action)?{key:input.key}:{})},getKey())
      if(record(reply)&&reply.ok===false&&record(reply.error)&&/^[A-Z0-9_]{1,80}$/.test(reply.error.code)&&
        Number.isInteger(reply.error.status)&&reply.error.status>=400&&reply.error.status<=599)return {ok:false,error:{code:reply.error.code,status:reply.error.status,message:'操作暂未完成，请重试'}}
      if(!record(reply)||reply.ok!==true||!record(reply.data)||!record(reply.actor)||reply.actor.appId!==identity.appId||reply.actor.openid!==identity.openid||
        typeof reply.actor.id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(reply.actor.id))return unavailable()
      return {ok:true,data:reply.data,actor:reply.actor}
    }catch(_){return unavailable()}
  }
}
module.exports={PATH,DOMAIN,ENDPOINT,send,createCompatBridge}
