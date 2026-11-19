import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {fileURLToPath} from 'node:url'

const root=fileURLToPath(new URL('..',import.meta.url))
const bundle=await build({entryPoints:[fileURLToPath(new URL('../src/faceReferencesApi.ts',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',target:'es2020'})
const api=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'))
const uiBundle=await build({stdin:{contents:"export { FaceReferences, FaceReferenceCard, FaceReferenceGallery, FacecapProviderOptions, faceReferenceDisplayLabel, faceReferenceSourceVideos, filterFaceReferenceCandidates } from './src/FaceReferences.tsx'; export { renderToStaticMarkup } from 'react-dom/server.browser'; export { createElement } from 'react';",resolveDir:root,loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser',target:'es2020',loader:{'.css':'empty'},define:{'process.env.NODE_ENV':'"production"'}})
const ui=await import('data:text/javascript;base64,'+Buffer.from(uiBundle.outputFiles[0].text).toString('base64'))
const channelId='instagram-manuel.ermachenko'
const id='12345678-1234-1234-1234-123456789abc'
const reference={id,channelId,label:'A reference <script>alert(1)</script>',angle:'unspecified',selected:false,width:240,height:320,createdAt:'2026-11-17T00:00:00Z',detection:'face',source:{kind:'video',sourceItemId:id,timeSeconds:14.2},asset:{key:'private/crop.jpg',sha256:'a'.repeat(64),bytes:1024,backend:'local'},contextAsset:{key:'private/context.jpg',sha256:'b'.repeat(64),bytes:2048,backend:'local'}}
const bank={references:[reference],storage:{backend:'local',cloudSynced:false,usedBytes:3072,maxBytes:128*1024*1024},generation:{available:false,provider:'siliconflow',model:'MiniMaxAI/MiniMax-H3',supportsReferenceImages:false},limits:{maxSelectedReferences:9}}
const render=(type,props)=>ui.renderToStaticMarkup(ui.createElement(type,props))
function fakeFetch(t,reply){const original=globalThis.fetch;globalThis.fetch=reply;t.after(()=>globalThis.fetch=original)}
const response=(value=bank)=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}})

test('reference gallery requires manual selection and escapes labels without claiming recognition',()=>{
  const html=render(ui.FaceReferenceGallery,{references:[reference],selectedCount:0,maxSelected:9,disabled:false,onUpdate:async()=>{},onOpenVideo:()=>{}})
  assert.match(html,/Detected face candidate · choose the intended person/)
  assert.match(html,/Use this reference/)
  assert.match(html,/Show source context/)
  assert.match(html,/Open source video/)
  assert.match(html,/0:14.2/)
  assert.match(html,/&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  assert.doesNotMatch(html,/<script>|Recognized as|identity confirmed|private\/crop/)
})
test('selection cap leaves unselecting available and full-image candidates labelled honestly',()=>{
  const blocked=render(ui.FaceReferenceCard,{reference,selectedCount:9,maxSelected:9,disabled:false,onUpdate:async()=>{}})
  assert.match(blocked,/<input[^>]*type="checkbox"[^>]*disabled/)
  const selected=render(ui.FaceReferenceCard,{reference:{...reference,selected:true,detection:'manual'},selectedCount:9,maxSelected:9,disabled:false,onUpdate:async()=>{}})
  assert.doesNotMatch(selected,/<input[^>]*type="checkbox"[^>]*disabled/)
  assert.match(selected,/Full image · no face crop established/)
})
test('blank labels use source fallbacks and small crops request a better reference',()=>{
  const blank={...reference,label:''}
  assert.equal(ui.faceReferenceDisplayLabel(blank),'Frame 0:14.2')
  assert.equal(ui.faceReferenceDisplayLabel({...blank,source:{kind:'photo',filename:'Portrait.png'}}),'Portrait.png')
  assert.equal(ui.faceReferenceDisplayLabel({...blank,source:{kind:'photo',filename:'  '}}),'Reference candidate')
  assert.equal(ui.faceReferenceDisplayLabel({...blank,source:{kind:'video',timeSeconds:NaN}}),'Reference candidate')
  assert.equal(ui.faceReferenceDisplayLabel({...blank,label:'  Chosen label  '}),'Chosen label')
  const html=render(ui.FaceReferenceCard,{reference:blank,selectedCount:0,maxSelected:9,disabled:false,onUpdate:async()=>{}})
  assert.match(html,/<h3>Frame 0:14.2<\/h3>/)
  assert.match(html,/Small crop — use a larger photo or source context/)
  assert.equal(blank.label,'')
  const full=render(ui.FaceReferenceCard,{reference:{...blank,width:256,height:256},selectedCount:0,maxSelected:9,disabled:false,onUpdate:async()=>{}})
  assert.doesNotMatch(full,/Small crop/)
})
test('extraction video choices require known duration within five minutes and saved media',()=>{
  const channel={id:channelId,handle:'manuel.ermachenko',platform:'instagram'}
  const item={id,source:{kind:'upload',channelId},hasMedia:true,status:'ready',durationSeconds:22.8}
  const invalid=[undefined,0,-1,NaN,Infinity,300.001].map((durationSeconds,index)=>({...item,id:`bad-${index}`,durationSeconds}))
  const values=ui.faceReferenceSourceVideos([item,{...item,id:'five-min',durationSeconds:300},...invalid,{...item,id:'not-saved',hasMedia:false},{...item,id:'still-importing',status:'importing'},{...item,id:'wrong-channel',source:{kind:'upload',channelId:'instagram-other'}}],channel)
  assert.deepEqual(values.map(value=>value.id),[id,'five-min'])
})
test('default gallery view hides only small unselected detected face crops',()=>{
  const small={...reference,id:'small',width:240,height:320}
  const short={...reference,id:'short',width:320,height:240}
  const large={...reference,id:'large',width:256,height:256}
  const original=[small,short,large]
  assert.deepEqual(ui.filterFaceReferenceCandidates(original).map(value=>value.id),['large'])
  assert.equal(original.length,3)
  assert.equal(small.selected,false)
})
test('selected small crops and manually reviewed full photos stay visible with the filter off',()=>{
  const selected={...reference,id:'selected-small',width:100,height:100,selected:true}
  const manual={...reference,id:'manual-small',width:100,height:100,detection:'manual'}
  assert.deepEqual(ui.filterFaceReferenceCandidates([selected,manual]).map(value=>value.id),['selected-small','manual-small'])
})
test('including small crops exposes every saved candidate without changing selection or metadata',()=>{
  const small={...reference,id:'small',width:80,height:120}
  const values=[small,{...reference,id:'large',width:512,height:512}]
  const shown=ui.filterFaceReferenceCandidates(values,true)
  assert.deepEqual(shown,values)
  assert.equal(shown[0],small)
  assert.equal(shown[0].selected,false)
})
test('empty workspace offers generic photos and local extraction with truthful cloud and generation status',()=>{
  const channel={id:channelId,handle:'manuel.ermachenko',name:'Manuel',platform:'instagram',url:'https://www.instagram.com/manuel.ermachenko/',style:{},discoveredVideos:[],createdAt:'',updatedAt:''}
  const html=render(ui.FaceReferences,{channel,items:[]})
  assert.match(html,/Build a reusable appearance reference set from any photo/)
  assert.match(html,/Saved locally · cloud storage later/)
  assert.match(html,/cloud sync is not enabled/)
  assert.match(html,/without automatic person recognition/)
  assert.match(html,/Select[^<]*photos here does not yet condition|Selecting photos here does not yet condition/)
  assert.match(html,/Current|current Generate recreation flow sends text prompts only/)
  assert.match(html,/type="file"[^>]*accept="image\/jpeg,image\/png"[^>]*multiple/)
  assert.match(html,/Save a video in this channel first/)
})
test('provider options distinguish appearance references from performance capture and have official docs',()=>{
  const html=render(ui.FacecapProviderOptions,{})
  assert.match(html,/up to nine reference images/)
  assert.match(html,/Kling Elements/)
  assert.match(html,/Runway References/)
  assert.match(html,/Face Cap is a facial motion-capture app/)
  assert.equal((html.match(/Not connected/g)||[]).length,3)
  for(const domain of ['platform.minimax.io','kling.ai','docs.dev.runwayml.com'])assert.ok(html.includes(domain))
  assert.doesNotMatch(html,/Generate now|guaranteed|perfect likeness/)
})
test('photo, capture, list and update requests preserve scoped IDs and exact allowed body shapes',async t=>{
  const calls=[]
  fakeFetch(t,async(url,options)=>{calls.push({url,options});return response(url.includes('/face-references/'+id)?{reference}:bank)})
  assert.deepEqual(await api.listFaceReferences(channelId),bank)
  const file=new File(['image bytes'],'my portrait.png',{type:'image/png'})
  await api.uploadFacePhoto(channelId,file)
  await api.extractFaceReferences(id)
  await api.updateFaceReference(id,{selected:true,angle:'front',label:'Front view'})
  assert.equal(calls[0].url,`/api/creator-agent/video-analysis/channels/${channelId}/face-references`)
  assert.match(calls[1].url,/filename=my%20portrait.png$/)
  assert.equal(calls[1].options.body,file);assert.equal(calls[1].options.headers['Content-Type'],'image/png')
  assert.equal(calls[2].options.method,'POST');assert.equal(calls[2].options.body,'{}')
  assert.equal(calls[3].options.method,'PATCH')
  assert.deepEqual(JSON.parse(calls[3].options.body),{selected:true,angle:'front',label:'Front view'})
  assert.ok(calls.every(call=>call.options.cache==='no-store'&&!call.options.headers?.authorization))
})
test('hostile IDs, unsupported photos and arbitrary update fields fail before a request',t=>{
  let calls=0;fakeFetch(t,async()=>{calls++;return response()})
  for(const bad of ['../private','https://example.com','instagram-X',null])assert.throws(()=>api.listFaceReferences(bad))
  for(const bad of ['../private','C:/secret.png','unknown'])assert.throws(()=>api.getFaceReferenceImage(bad))
  for(const file of [new File(['x'],'portrait.svg',{type:'image/svg+xml'}),new File([''],'empty.jpg',{type:'image/jpeg'}),new File([new Uint8Array(api.FACE_PHOTO_MAX_BYTES+1)],'large.jpg',{type:'image/jpeg'})])assert.throws(()=>api.uploadFacePhoto(channelId,file),/JPEG or PNG/)
  for(const value of [{path:'private'},{angle:'identity'},{selected:'yes'},{label:'x'.repeat(121)}])assert.throws(()=>api.updateFaceReference(id,value))
  assert.equal(calls,0)
})
test('private image and ZIP downloads enforce content types, length bounds and exact context query',async t=>{
  const calls=[];fakeFetch(t,async(url)=>{calls.push(url);return new Response('image',{headers:{'content-type':'image/jpeg'}})})
  const image=await api.getFaceReferenceImage(id,true)
  assert.equal(image.type,'image/jpeg');assert.equal(image.size,5)
  assert.equal(calls[0],`/api/creator-agent/video-analysis/face-references/${id}/image?context=1`)
  globalThis.fetch=async()=>new Response('zip',{headers:{'content-type':'application/zip'}})
  assert.equal((await api.exportFaceReferencePack(channelId)).type,'application/zip')
  globalThis.fetch=async()=>new Response('oops',{headers:{'content-type':'text/html'}})
  await assert.rejects(api.getFaceReferenceImage(id),/unsupported file/)
  globalThis.fetch=async()=>new Response('zip',{headers:{'content-type':'application/zip','content-length':String(api.FACE_PACK_MAX_BYTES+1)}})
  await assert.rejects(api.exportFaceReferencePack(channelId),/download limit/)
})
test('oversized chunked downloads cancel their reader and errors retain useful server status',async t=>{
  let cancelled=false
  fakeFetch(t,async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(2*1024*1024+1))},cancel(){cancelled=true}}),{headers:{'content-type':'image/jpeg'}}))
  await assert.rejects(api.getFaceReferenceImage(id),/download limit/);assert.equal(cancelled,true)
  globalThis.fetch=async()=>response({error:'Selected reference limit reached.'})
  globalThis.fetch=async()=>new Response(JSON.stringify({error:'Selected reference limit reached.'}),{status:409,headers:{'content-type':'application/json'}})
  await assert.rejects(api.updateFaceReference(id,{selected:true}),{message:'Selected reference limit reached.',status:409})
})
