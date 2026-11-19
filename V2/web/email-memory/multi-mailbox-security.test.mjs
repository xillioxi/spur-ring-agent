import test from 'node:test'
import assert from 'node:assert/strict'
import {join} from 'node:path'
import {createOutlookProvider,finishOutlookOAuth} from './outlook.mjs'

const clientId='11111111-2222-4333-8444-555555555555'
const json=value=>new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}})
function slotStore(){let current=null,writes=0;return {storage:'session',get writes(){return writes},async get(){return current?structuredClone(current):null},async set(value){writes++;current=structuredClone(value)},async clear(){current=null}}}
function callback(start,code){return new URLSearchParams({state:new URL(start.authorizationUrl).searchParams.get('state'),code})}

test('Microsoft OAuth state cannot write credentials into a different mailbox slot, including slots for the same email',async()=>{
  const first=slotStore(),second=slotStore(),calls=[]
  const fetchImpl=async(raw,options)=>{
    const url=new URL(raw);calls.push({url,options})
    if(url.hostname==='login.microsoftonline.com')return json({access_token:'synthetic-slot-token',refresh_token:'synthetic-slot-refresh',scope:'Mail.Read User.Read',expires_in:3600})
    assert.equal(url.origin,'https://graph.microsoft.com');assert.equal(url.pathname,'/v1.0/me');assert.equal(url.searchParams.get('$select'),'id,mail,userPrincipalName')
    return json({id:'same-microsoft-identity',mail:'same-person@example.com'})
  }
  const providerA=createOutlookProvider({root:join(process.cwd(),'synthetic-mailbox-slot-a'),credentials:first,fetchImpl,config:{OUTLOOK_CLIENT_ID:clientId}})
  const providerB=createOutlookProvider({root:join(process.cwd(),'synthetic-mailbox-slot-b'),credentials:second,fetchImpl,config:{OUTLOOK_CLIENT_ID:clientId}})
  const startA=await providerA.startOAuth(),startB=await providerB.startOAuth()
  await assert.rejects(providerB.finishOAuth(callback(startA,'first-slot-code')),{code:'outlook_invalid_state'})
  assert.equal(first.writes,0);assert.equal(second.writes,0);assert.equal(calls.length,0)
  const connectedA=await finishOutlookOAuth(callback(startA,'first-slot-code'))
  assert.equal(connectedA.email,'same-person@example.com');assert.equal(first.writes,1);assert.equal(second.writes,0)
  assert.equal((await providerB.status()).connected,false)
  const connectedB=await finishOutlookOAuth(callback(startB,'second-slot-code'))
  assert.equal(connectedB.email,connectedA.email);assert.equal(connectedB.accountId,connectedA.accountId)
  assert.equal(first.writes,1);assert.equal(second.writes,1)
  await providerA.disconnect();assert.equal((await providerA.status()).connected,false);assert.equal((await providerB.status()).connected,true)
})

test('starting a replacement Microsoft authorization invalidates the old state only in that mailbox slot',async()=>{
  const store=slotStore(),calls=[]
  const fetchImpl=async(raw,options)=>{
    const url=new URL(raw);calls.push({url,options})
    if(url.hostname==='login.microsoftonline.com'){
      assert.equal(options.body.get('code'),'newest-authorization-code')
      return json({access_token:'synthetic-latest-token',refresh_token:'synthetic-latest-refresh',scope:'Mail.Read User.Read',expires_in:3600})
    }
    return json({id:'current-identity',mail:'current@example.com'})
  }
  const provider=createOutlookProvider({root:join(process.cwd(),'synthetic-mailbox-replaced-state'),credentials:store,fetchImpl,config:{OUTLOOK_CLIENT_ID:clientId}})
  const old=await provider.startOAuth(),latest=await provider.startOAuth()
  await assert.rejects(finishOutlookOAuth(callback(old,'superseded-code')),{code:'outlook_invalid_state'})
  assert.equal(calls.length,0);assert.equal(store.writes,0)
  await finishOutlookOAuth(callback(latest,'newest-authorization-code'))
  assert.equal(calls.length,2);assert.equal(store.writes,1)
  await assert.rejects(finishOutlookOAuth(callback(latest,'replayed-code')),{code:'outlook_invalid_state'})
  assert.equal(store.writes,1)
})
