import test from 'node:test'
import assert from 'node:assert/strict'
import {Readable} from 'node:stream'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {handleSocialArchive} from '../social-archives.mjs'

test('Meta exports persist across reads, merge split files, and isolate providers and accounts',async t=>{
  const root=await mkdtemp(join(tmpdir(),'spur-archives-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  async function request(provider,account,payload,thread){
    const url=new URL('http://localhost/')
    url.searchParams.set('provider',provider)
    url.searchParams.set('account',account)
    if(thread)url.searchParams.set('thread',thread)
    const req=Readable.from(payload?[Buffer.from(JSON.stringify(payload))]:[])
    req.method=payload?'POST':'GET'
    const result={}
    await handleSocialArchive(req,{writeHead(status){result.status=status},end(body){result.body=JSON.parse(body)}},root,url)
    return result
  }
  const message={title:'Friends',thread_path:'inbox/friends',messages:[{sender_name:'Alice',timestamp_ms:123,content:'Hello'}]}
  for(const provider of ['instagram','messenger']){
    assert.equal((await request(provider,'Studio',message)).body.added,1)
    assert.equal((await request(provider,'Studio',message)).body.added,0)
    const more={...message,messages:[{sender_name:'Bob',timestamp_ms:456,content:'Hi!'}]}
    assert.equal((await request(provider,'Studio',more)).body.added,1)
    assert.equal((await request(provider,'Personal',message)).body.added,1)
    const {threads}= (await request(provider,'')).body
    assert.equal(threads.length,2)
    const studio=threads.find(t=>t.account==='Studio')
    assert.equal(studio.count,2)
    const {messages}=(await request(provider,'',null,studio.id)).body
    assert.deepEqual(messages.map(m=>m.body),['Hi!','Hello'])
    assert.equal((await request(provider==='instagram'?'messenger':'instagram','',null,studio.id)).body.messages.length,0)
  }
  assert.equal((await request('instagram','Studio',{messages:[]})).status,422)
})
