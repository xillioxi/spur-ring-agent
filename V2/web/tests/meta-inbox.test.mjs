import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createMetaInbox,handleMetaLogin} from '../meta-inbox.mjs'
import {openSocialArchive} from '../social-archives.mjs'

test('Meta login binds the callback to its browser, syncs both providers and resumes without duplicate messages',async t=>{
  const root=await mkdtemp(join(tmpdir(),'spur-meta-inbox-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  let reads=0
  const fetcher=async(url,options)=>{
    const path=url.pathname.split('/').slice(2).join('/')
    if(path==='oauth/access_token'){
      assert.equal(options.method,'POST')
      return Response.json({access_token:options.body.has('code')?'short':'extended'})
    }
    if(path==='me/accounts'){
      assert.equal(options.headers.Authorization,'Bearer extended')
      return Response.json({data:[{id:'42',name:'Studio Page',tasks:['MESSAGING'],access_token:'page-secret',instagram_business_account:{id:'77',username:'studio'}}]})
    }
    assert.equal(options.headers.Authorization,'Bearer page-secret')
    if(path==='42/conversations')return Response.json({data:[{id:'thread',updated_time:'today',participants:{data:[{id:'person',name:'Alex'}]}}]})
    if(path==='thread/messages'){
      reads++
      return Response.json({data:[{id:'m1',created_time:'2026-11-16T09:00:00Z',from:{name:'Alex'},message:'Hello'}]})
    }
    throw new Error('Unexpected Graph request')
  }
  const inbox=createMetaInbox(root,{META_APP_ID:'app',META_APP_SECRET:'secret'},{fetcher,storeFor:()=>{
    let value=null
    return {get:async()=>value,set:async next=>{value=next},clear:async()=>{value=null}}
  }})
  t.after(()=>inbox.stop())
  const invoke=async(url,cookie='')=>{
    const result={}
    await handleMetaLogin({method:'GET',headers:{cookie}},{
      writeHead(status,headers){Object.assign(result,{status,headers})},end(body){result.body=body}
    },url)
    return result
  }
  for(const provider of ['instagram','messenger']){
    const start=new URL(inbox.start(provider).url)
    const authorized=await invoke(start)
    assert.equal(authorized.status,302)
    const url=new URL(authorized.headers.Location)
    assert.equal(url.hostname,'www.facebook.com')
    assert.match(url.searchParams.get('scope'),provider==='instagram'?/instagram_manage_messages/:/pages_messaging/)
    const callback=new URL(url.searchParams.get('redirect_uri'))
    callback.searchParams.set('state',url.searchParams.get('state'));callback.searchParams.set('code','fixture')
    assert.equal((await invoke(callback)).status,400)
    const cookie=authorized.headers['Set-Cookie'].split(';')[0]
    assert.equal((await invoke(callback,cookie)).status,200)
    assert.equal((await invoke(callback,cookie)).status,400)
    await inbox.schedule(provider)
    const status=await inbox.status(provider)
    assert.equal(status.accounts.length,1);assert.ok(status.updated);assert.ok(!JSON.stringify(status).includes('page-secret'))
    const before=reads
    await inbox.schedule(provider);assert.equal(reads,before)
    await inbox.disconnect(provider);assert.deepEqual((await inbox.status(provider)).accounts,[])
  }
  const db=await openSocialArchive(root)
  try{
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM threads').get().n,2)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,2)
  }finally{db.close()}
})
