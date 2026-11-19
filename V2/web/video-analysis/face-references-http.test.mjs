import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {Readable,Writable} from 'node:stream'
import {createVideoAnalysisService,waitForVideoAnalysisIdle} from './service.mjs'
import {createFaceReferenceStore} from './face-references.mjs'
import {handleVideoAnalysisRequest,VIDEO_ANALYSIS_PREFIX as prefix} from './http.mjs'

const channel='instagram-dreamcode_films'
// A minimal JPEG header fixture: these tests verify scoped transport, not decoding.
const image=Buffer.from([255,216,255,192,0,17,8,0,8,0,8,3,1,17,0,2,17,1,3,17,1,255,217]).toString('base64')
const candidate=time=>({imageBase64:image,contextBase64:image,width:8,height:8,contextWidth:8,contextHeight:8,sourceTimeSeconds:time,detection:'manual',cropBox:{x:0,y:0,width:1,height:1},quality:{sharpness:0,brightness:.5}})
class Response extends Writable {
  constructor(){super();this.headers={};this.parts=[];this.statusCode=200;this.headersSent=false}
  _write(chunk,_encoding,done){this.parts.push(Buffer.from(chunk));done()}
  writeHead(status,headers){this.statusCode=status;this.headers=headers;this.headersSent=true;return this}
  json(){return JSON.parse(Buffer.concat(this.parts).toString())}
}
async function request(options,path,{method='GET',body,headers={}}={}){
  const payload=body===undefined?[]:[Buffer.isBuffer(body)?body:Buffer.from(JSON.stringify(body))]
  const req=Readable.from(payload);Object.assign(req,{url:prefix+path,method,headers})
  const res=new Response();await handleVideoAnalysisRequest(req,res,options)
  if(!res.writableFinished&&!res.destroyed)await new Promise(done=>res.once('finish',done))
  return res
}
async function fixture(t){
  const root=await mkdtemp(join(process.cwd(),'.face-http-test-'))
  t.after(async()=>{await waitForVideoAnalysisIdle();await rm(root,{recursive:true,force:true})})
  const engine={analyze:async()=>({schemaVersion:1,status:'complete',metadata:{durationSeconds:6},shots:[],script:{text:'',segments:[],onScreenText:[]},warnings:[]})}
  const service=createVideoAnalysisService({root,engine})
  createFaceReferenceStore({root,photoProcessor:async()=>({candidates:[candidate(null)],warnings:[]}),videoProcessor:async()=>({candidates:[candidate(2)],warnings:[]})})
  return {root,engine,service}
}

test('Facecap HTTP uploads, manual selection, private images and ZIP export share the profile bank',async t=>{
  const options=await fixture(t)
  const empty=await request(options,`/channels/${channel}/face-references`)
  assert.equal(empty.statusCode,200);assert.equal(empty.json().storage.cloudSynced,false)
  const uploaded=await request(options,`/channels/${channel}/face-references?filename=photo.jpg`,{method:'POST',body:Buffer.from('photo'),headers:{'content-type':'image/jpeg','content-length':'5'}})
  assert.equal(uploaded.statusCode,201)
  const [reference]=uploaded.json().references
  assert.equal(reference.selected,false);assert.doesNotMatch(JSON.stringify(uploaded.json()),/imageBase64|filePath/)
  const selected=await request(options,`/face-references/${reference.id}`,{method:'PATCH',headers:{'content-type':'application/json'},body:{selected:true,angle:'front',label:'Demo reference'}})
  assert.equal(selected.statusCode,200);assert.equal(selected.json().reference.selected,true)
  const picture=await request(options,`/face-references/${reference.id}/image?context=1`)
  assert.equal(picture.statusCode,200);assert.equal(picture.headers['Content-Type'],'image/jpeg')
  assert.equal(picture.headers['Cache-Control'],'private, no-store');assert.equal(Buffer.concat(picture.parts).toString('base64'),image)
  const head=await request(options,`/face-references/${reference.id}/image`,{method:'HEAD'})
  assert.equal(head.parts.length,0)
  const pack=await request(options,`/channels/${channel}/face-references/export`)
  assert.equal(pack.statusCode,200);assert.equal(pack.headers['Content-Type'],'application/zip')
  assert.equal(Buffer.concat(pack.parts).readUInt32LE(0),0x04034b50)
  const other=await fixture(t)
  assert.equal((await request(other,`/face-references/${reference.id}/image`)).statusCode,404)
})

test('Facecap request schemas reject paths, provider configuration and malformed upload metadata',async t=>{
  const options=await fixture(t),headers={'content-type':'application/json'},id='12345678-1234-1234-1234-123456789abc'
  for(const path of [`/channels/${channel}/face-references?path=C:/private`,`/face-references/${id}/image?context=evil`,`/face-references/${id}/image?path=secret`])assert.equal((await request(options,path)).statusCode,400)
  assert.equal((await request(options,`/face-references/${id}`,{method:'PATCH',headers,body:{filePath:'C:/secret'}})).statusCode,400)
  assert.equal((await request(options,`/items/${id}/face-candidates`,{method:'POST',headers,body:{source:'C:/secret',config:{}}})).statusCode,400)
  assert.equal((await request(options,`/channels/${channel}/face-references?filename=photo.jpg`,{method:'POST',body:Buffer.from('x'),headers:{'content-type':'image/jpeg','content-length':'NaN'}})).statusCode,400)
  assert.equal((await request(options,`/channels/${channel}/face-references?filename=photo.svg`,{method:'POST',body:Buffer.from('<svg/>'),headers:{'content-type':'image/svg+xml'}})).statusCode,415)
})

test('Facecap video extraction uses only the checked saved video and records its source time',async t=>{
  const options=await fixture(t)
  const item=await options.service.upload(Readable.from([Buffer.from('video')]),{filename:'source.mp4',channelId:channel})
  await options.service.analyze(item.id);await options.service.whenIdle()
  const extracted=await request(options,`/items/${item.id}/face-candidates`,{method:'POST',headers:{'content-type':'application/json'},body:{}})
  assert.equal(extracted.statusCode,201)
  const [reference]=extracted.json().references
  assert.equal(reference.source.sourceItemId,item.id);assert.equal(reference.source.timeSeconds,2)
  assert.equal(reference.selected,false);assert.equal(reference.detection,'manual')
  const noChannel=await options.service.upload(Readable.from([Buffer.from('video')]),{filename:'unassigned.mp4'})
  assert.equal((await request(options,`/items/${noChannel.id}/face-candidates`,{method:'POST',headers:{'content-type':'application/json'},body:{}})).statusCode,409)
})
