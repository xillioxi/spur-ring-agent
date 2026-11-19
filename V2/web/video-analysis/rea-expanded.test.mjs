import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {Readable,Writable} from 'node:stream'
import {createVideoAnalysisService} from './service.mjs'
import {handleVideoAnalysisRequest,VIDEO_ANALYSIS_PREFIX as prefix} from './http.mjs'

const id='12345678-1234-1234-1234-123456789abc'
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMZ0AAAAASUVORK5CYII='
async function fixture(t,{rea=true,asset={}}={}) {
  const root=await mkdtemp(join(process.cwd(),'.rea-expanded-test-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  const result={schemaVersion:1,status:'partial',analysisWorkflowId:rea?'rea-video':'standard',shots:[],script:{segments:[],text:'',onScreenText:[]},metadata:{durationSeconds:12},provenance:{workflow:{id:rea?'rea-video':'standard',status:'unreviewed'}},...(rea?{reaVideo:{schemaVersion:1,reviewStatus:'unreviewed',vlmStatus:'not_requested',technicalShots:[],limitations:[],sections:[{id:'look',title:'Camera and lighting',body:'Estimated fixed camera.'}],soundCandidates:[{startSeconds:2,endSeconds:2.2,description:'Possible transient'}],capabilities:[{id:'ocr',label:'Captions',status:'requires_download',detail:'OCR not run.'}],assets:[{id:'storyboard',label:'Storyboard',contentType:'image/png',dataBase64:png,...asset}]}}:{})}
  await writeFile(join(root,'reference-library.json'),JSON.stringify({schemaVersion:1,items:[{id,title:'Local fixture',status:'partial',durationSeconds:12,createdAt:'2026-11-16T00:00:00.000Z',updatedAt:'2026-11-16T00:00:00.000Z',result}]}))
  return {root,service:createVideoAnalysisService({root})}
}
class Response extends Writable {
  constructor(){super();this.headers={};this.parts=[];this.statusCode=200;this.headersSent=false}
  _write(chunk,_encoding,done){this.parts.push(Buffer.from(chunk));done()}
  writeHead(status,headers){this.statusCode=status;this.headers=headers;this.headersSent=true;return this}
  json(){return JSON.parse(Buffer.concat(this.parts).toString())}
}
async function request(options,path,{method='GET',body}={}) {
  const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))])
  Object.assign(req,{url:`${prefix}/items/${id}/${path}`,method,headers:{'content-type':'application/json'}})
  const res=new Response()
  await handleVideoAnalysisRequest(req,res,options)
  if(!res.writableFinished&&!res.destroyed)await new Promise(done=>res.once('finish',done))
  return res
}

test('Rea images are private fixed-ID assets and never inflate public item or JSON exports',async t=>{
  const {service}=await fixture(t)
  const item=await service.get(id)
  assert.equal(item.result.reaVideo.assets[0].dataBase64,undefined)
  assert.equal(item.result.reaVideo.assets[0].bytes,Buffer.byteLength(png,'base64'))
  const value=await service.getReaAsset(id,'storyboard')
  assert.equal(value.contentType,'image/png');assert.equal(value.bytes.toString('base64'),png)
  for(const asset of ['../storyboard','C:/private.png','storyboard.png','shot-000/../storyboard',null])await assert.rejects(service.getReaAsset(id,asset),{status:404})
  const exported=(await service.exportItem(id,{format:'json'})).body
  assert.doesNotMatch(exported,/dataBase64/)
})

test('Rea image reads reject invalid image bytes, media types and oversized data',async t=>{
  for(const asset of [{contentType:'text/html'},{dataBase64:Buffer.from('<script>evil</script>').toString('base64')},{dataBase64:'%%%not-base64'},{dataBase64:'a'.repeat(350004)}]) {
    const {service}=await fixture(t,{asset})
    await assert.rejects(service.getReaAsset(id,'storyboard'),{status:404})
  }
})

test('manual Rea notes save without changing heuristic or model-review provenance and appear in exports',async t=>{
  const {root,service}=await fixture(t)
  const item=await service.updateReaReview(id,{summary:'A deliberately impossible chess ending.',payoff:'The pawn is replaced by a king.',corrections:'User observation; not automatically inferred.'})
  assert.equal(item.status,'partial');assert.equal(item.result.reaVideo.reviewStatus,'unreviewed')
  assert.equal(item.result.reaVideo.vlmStatus,'not_requested')
  assert.equal(item.result.reaVideo.reviewNotes.source,'user')
  assert.match(item.result.reaVideo.reviewNotes.updatedAt,/^\d{4}-/)
  const saved=JSON.parse(await readFile(join(root,'reference-library.json'),'utf8'))
  assert.equal(saved.items[0].result.reaVideo.reviewNotes.payoff,'The pawn is replaced by a king.')
  for(const format of ['txt','md','json']) {
    const body=(await service.exportItem(id,{format})).body
    assert.match(body,/pawn is replaced by a king/)
    assert.match(body,/Estimated fixed camera/)
    assert.match(body,/OCR not run/)
    if(format!=='json')assert.match(body,/supplied manually, not model findings/)
  }
  const cleared=await service.updateReaReview(id,{})
  assert.equal(cleared.result.reaVideo.reviewNotes.payoff,'')
})

test('manual notes reject unknown fields, non-text, overlong text and non-Rea results',async t=>{
  const {service}=await fixture(t)
  for(const value of [{story:'unknown'},{summary:17},{hook:'x'.repeat(4001)},{corrections:'a\0b'},null,[]])await assert.rejects(service.updateReaReview(id,value),{status:400})
  const standard=await fixture(t,{rea:false})
  await assert.rejects(standard.service.updateReaReview(id,{summary:'x'}),{status:409})
})

test('Rea routes enforce methods, allowlisted queries, private images and strict review bodies',async t=>{
  const options=await fixture(t)
  const image=await request(options,'rea-assets?asset=storyboard')
  assert.equal(image.statusCode,200);assert.equal(image.headers['Content-Type'],'image/png')
  assert.equal(image.headers['Cache-Control'],'private, no-store')
  assert.equal(Buffer.concat(image.parts).toString('base64'),png)
  const head=await request(options,'rea-assets?asset=storyboard',{method:'HEAD'})
  assert.equal(head.statusCode,200);assert.equal(head.parts.length,0)
  const download=await request(options,'rea-assets?asset=storyboard&download=1')
  assert.match(download.headers['Content-Disposition'],/^attachment;/)
  for(const path of ['rea-assets?asset=storyboard&path=C:/secret','rea-assets?asset=storyboard&asset=storyboard','rea-assets?asset=storyboard&download=evil','rea-frames?start=&end=10','rea-frames?start=0&end=NaN','rea-frames?start=0&end=10&path=secret'])assert.equal((await request(options,path)).statusCode,400)
  assert.equal((await request(options,'rea-review',{method:'PUT',body:{payoff:'Manual ending'}})).statusCode,200)
  assert.equal((await request(options,'rea-review',{method:'PUT',body:{reviewStatus:'reviewed'}})).statusCode,400)
  assert.equal((await request(options,'rea-review',{method:'POST',body:{payoff:'Wrong method'}})).statusCode,404)
})
