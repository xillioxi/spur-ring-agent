import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,readFile,writeFile,rm,readdir,symlink} from 'node:fs/promises'
import {join} from 'node:path'
import {Readable} from 'node:stream'
import {crc32} from 'node:zlib'
import {createFaceReferenceStore,FACE_REFERENCE_LIMITS as limits} from './face-references.mjs'

const channel='instagram-manuel.ermachenko',other='instagram-other'
const sourceItemId='12345678-1234-1234-1234-123456789abc'
const image='/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCnRRRXYch//9k='
const candidate=(extra={})=>({imageBase64:image,contextBase64:image,width:2,height:2,contextWidth:2,contextHeight:2,sourceTimeSeconds:null,detection:'face',cropBox:{x:.1,y:.1,width:.5,height:.5},quality:{sharpness:50,brightness:.5},...extra})
async function fixture(t,{photoProcessor=async()=>({candidates:[candidate()],warnings:[]}),videoProcessor=async()=>({candidates:[candidate({sourceTimeSeconds:1})],warnings:[]})}={}){
  const root=await mkdtemp(join(process.cwd(),'.face-ref-test-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  return {root,store:createFaceReferenceStore({root,photoProcessor,videoProcessor,getConfig:()=>({SPUR_REA_VIDEO_PYTHON:'host-only-runtime'})})}
}
const upload=(store,id=channel,options={})=>store.upload(id,Readable.from([Buffer.from('test-photo')]),{filename:'portrait.jpg',contentLength:10,contentType:'image/jpeg',...options})
function unzip(bytes){
  const entries=new Map();let cursor=0
  while(bytes.readUInt32LE(cursor)===0x04034b50){const size=bytes.readUInt32LE(cursor+18),nameLength=bytes.readUInt16LE(cursor+26),extraLength=bytes.readUInt16LE(cursor+28),name=bytes.toString('utf8',cursor+30,cursor+30+nameLength),start=cursor+30+nameLength+extraLength,data=bytes.subarray(start,start+size);assert.equal(crc32(data),bytes.readUInt32LE(cursor+14));assert.equal(bytes.readUInt16LE(cursor+8),0);entries.set(name,data);cursor=start+size}
  assert.equal(bytes.readUInt32LE(cursor),0x02014b50);assert.equal(bytes.readUInt32LE(bytes.length-22),0x06054b50);return entries
}

test('photos become unselected private references with hashes, context and source metadata',async t=>{
  const {root,store}=await fixture(t)
  const bank=await upload(store),[reference]=bank.references
  assert.equal(reference.channelId,channel);assert.equal(reference.selected,false);assert.equal(reference.angle,'unspecified')
  assert.deepEqual(reference.source,{kind:'photo',filename:'portrait.jpg'})
  assert.deepEqual(reference.cropBox,{x:.1,y:.1,width:.5,height:.5})
  assert.equal(reference.asset.backend,'local');assert.match(reference.asset.sha256,/^[a-f0-9]{64}$/)
  assert.equal(reference.asset.bytes,Buffer.byteLength(image,'base64'))
  assert.equal(bank.storage.cloudSynced,false);assert.equal(bank.generation.supportsReferenceImages,false)
  assert.doesNotMatch(JSON.stringify(bank),/imageBase64|contextBase64|filePath|C:\\Users|\.face-ref-test-/)
  const face=await store.image(reference.id),context=await store.image(reference.id,{context:true})
  assert.equal(face.contentType,'image/jpeg');assert.equal(face.size,reference.asset.bytes)
  assert.equal((await readFile(face.filePath)).toString('base64'),image);assert.notEqual(face.filePath,context.filePath)
  assert.equal((await readdir(join(root,'face-references','incoming'))).length,0)
  assert.equal(bank.storage.usedBytes,(await store.list(channel)).storage.usedBytes)
})

test('uploads reject invalid channels, filenames, MIME and declared sizes before processing',async t=>{
  let calls=0;const {store}=await fixture(t,{photoProcessor:async()=>{calls++;return {candidates:[candidate()]}}})
  for(const id of ['unassigned','../instagram-x',null,'instagram-..'])await assert.rejects(upload(store,id),{status:404})
  for(const filename of ['../face.jpg','C:\\private.jpg','a\0.jpg','a'.repeat(241)])await assert.rejects(upload(store,channel,{filename}),{status:422})
  await assert.rejects(upload(store,channel,{contentType:'image/svg+xml'}),{status:415})
  await assert.rejects(upload(store,channel,{contentLength:limits.maxPhotoBytes+1}),{status:413})
  await assert.rejects(upload(store,channel,{contentLength:0}),{status:400})
  assert.equal(calls,0)
})

test('bounded streaming rejects over-limit and incomplete uploads and cleans the temporary file',async t=>{
  const {root,store}=await fixture(t)
  await assert.rejects(store.upload(channel,Readable.from([Buffer.alloc(limits.maxPhotoBytes+1)]),{filename:'large.jpg'}),{status:413})
  await assert.rejects(upload(store,channel,{contentLength:11}),{status:400})
  await assert.rejects(upload(store,channel,{contentLength:9}),{status:413})
  assert.equal((await store.list(channel)).references.length,0)
  assert.deepEqual(await readdir(join(root,'face-references','incoming')),[])
})

test('malformed worker images, dimensions, timing and candidate counts never persist',async t=>{
  for(const value of [candidate({imageBase64:'%%%'}),candidate({imageBase64:Buffer.from('<html>not-image</html>').toString('base64')}),candidate({width:100}),candidate({contextBase64:'a'.repeat(700000)}),candidate({detection:'recognized-person'})]){
    const {store}=await fixture(t,{photoProcessor:async()=>({candidates:[value]})})
    await assert.rejects(upload(store),{status:502});assert.equal((await store.list(channel)).references.length,0)
  }
  const {store}=await fixture(t,{photoProcessor:async()=>({candidates:Array.from({length:13},()=>candidate())}),videoProcessor:async()=>({candidates:[candidate({sourceTimeSeconds:99})]})})
  await assert.rejects(upload(store),{status:502})
})

test('capture accepts only a checked saved local source and keeps frame provenance',async t=>{
  let received
  const {root,store}=await fixture(t,{videoProcessor:async value=>{received=value;return {candidates:[candidate({sourceTimeSeconds:3.5})],warnings:['Candidates require manual person selection.']}}})
  const source=join(root,'source.mp4');await writeFile(source,'video')
  const bank=await store.capture(channel,{filePath:source,sourceItemId,durationSeconds:5})
  assert.equal(received.filePath,source);assert.equal(received.durationSeconds,5);assert.equal(received.config.SPUR_REA_VIDEO_PYTHON,'host-only-runtime')
  assert.deepEqual(bank.references[0].source,{kind:'video',sourceItemId,timeSeconds:3.5})
  assert.match(bank.warnings[0],/manual/)
  await assert.rejects(store.capture(channel,{filePath:source,sourceItemId:'../wrong',durationSeconds:5}),{status:404})
  await assert.rejects(store.capture(channel,{filePath:source,sourceItemId,durationSeconds:301}),{status:422})
  await assert.rejects(store.capture(channel,{filePath:'https://example.com/video.mp4',sourceItemId,durationSeconds:5}),{status:422})
  await assert.rejects(store.capture(channel,{filePath:join(root,'..','outside.mp4'),sourceItemId,durationSeconds:5}),{status:503})
  const invalid=await fixture(t,{videoProcessor:async()=>({candidates:[candidate({sourceTimeSeconds:99})]})});const invalidSource=join(invalid.root,'source.mp4');await writeFile(invalidSource,'video');await assert.rejects(invalid.store.capture(channel,{filePath:invalidSource,sourceItemId,durationSeconds:5}),{status:502})
})

test('user selection and angle labels persist without establishing identity; pack is valid ZIP',async t=>{
  const {store}=await fixture(t);const reference=(await upload(store)).references[0]
  await assert.rejects(store.exportPack(channel),{status:409})
  const changed=await store.update(reference.id,{selected:true,angle:'left',label:'  Three-quarter view  '})
  assert.equal(changed.label,'Three-quarter view');assert.equal(changed.angle,'left');assert.equal(changed.detection,'face')
  const pack=await store.exportPack(channel)
  assert.equal(pack.contentType,'application/zip');assert.ok(pack.bytes.length<limits.maxPackBytes)
  const entries=unzip(pack.bytes),manifest=JSON.parse(entries.get('manifest.json'))
  assert.equal(entries.size,3);assert.equal(manifest.references[0].id,reference.id)
  assert.match(manifest.source,/no automatic identity recognition/);assert.equal(manifest.storage.cloudSynced,false)
  assert.equal(entries.get(manifest.references[0].files.face).toString('base64'),image)
  assert.doesNotMatch(entries.get('manifest.json').toString(),/imageBase64|contextBase64|filePath|\.face-ref-test-/)
  for(const value of [{recognizedAs:'Manuel'},{selected:'yes'},{angle:'unknown'},{label:'a'.repeat(121)},{label:'a\0b'},{}])await assert.rejects(store.update(reference.id,value),{status:400})
})

test('selection and channel quotas are enforced without partial insertion',async t=>{
  const {store}=await fixture(t,{photoProcessor:async()=>({candidates:Array.from({length:12},()=>candidate())})})
  const bank=await upload(store)
  for(const reference of bank.references.slice(0,9))await store.update(reference.id,{selected:true})
  await assert.rejects(store.update(bank.references[9].id,{selected:true}),{status:409})
  for(let i=0;i<9;i++)await upload(store)
  assert.equal((await store.list(channel)).references.length,120)
  await assert.rejects(upload(store),{status:507})
  assert.equal((await store.list(channel)).references.length,120)
})

test('workspace quota includes existing files and preserves the reference index',async t=>{
  const {root,store}=await fixture(t);await store.list(channel)
  const huge=join(root,'face-references','capacity.fixture');const file=await import('node:fs/promises').then(fs=>fs.open(huge,'w'));await file.truncate(limits.maxStorageBytes-2);await file.close()
  await assert.rejects(upload(store),{status:507});assert.equal((await store.list(channel)).references.length,0)
})

test('separate profiles and channels do not expose each other’s reference records',async t=>{
  const first=await fixture(t),second=await fixture(t)
  const reference=(await upload(first.store)).references[0]
  assert.equal((await first.store.list(other)).references.length,0)
  assert.equal((await second.store.list(channel)).references.length,0)
  await assert.rejects(second.store.image(reference.id),{status:404});await assert.rejects(second.store.update(reference.id,{selected:true}),{status:404})
  for(const id of ['../private','C:/secret',null])await assert.rejects(first.store.image(id),{status:404})
})

test('repeated store construction shares serialization and concurrent uploads do not overwrite records',async t=>{
  const {root,store}=await fixture(t)
  const reused=createFaceReferenceStore({root,photoProcessor:async()=>({candidates:[candidate()]})})
  assert.equal(reused,store)
  await Promise.all([upload(store),upload(reused)])
  assert.equal((await store.list(channel)).references.length,2)
  const index=JSON.parse(await readFile(join(root,'face-references','index.json'),'utf8'));assert.equal(index.references.length,2)
})

test('image tampering and symlinked storage are rejected',async t=>{
  const {store}=await fixture(t),reference=(await upload(store)).references[0],location=await store.image(reference.id)
  await writeFile(location.filePath,Buffer.alloc(reference.asset.bytes))
  await assert.rejects(store.image(reference.id),{status:404})
  const isolated=await fixture(t),outside=await fixture(t);await mkdir(join(isolated.root,'face-references'),{recursive:true})
  try{await symlink(outside.root,join(isolated.root,'face-references','images'),process.platform==='win32'?'junction':'dir')}catch(error){if(['EPERM','EACCES'].includes(error.code)){t.diagnostic('Symlink fixture unavailable in this environment.');return}throw error}
  await assert.rejects(isolated.store.list(channel),{status:503})
})

test('processor failure is sanitized and temporary data is removed',async t=>{
  const {root,store}=await fixture(t,{photoProcessor:async()=>{throw Error('C:/private/secret.jpg token=private')}})
  await assert.rejects(upload(store),error=>error.code==='face_reference_processing'&&!/secret|token=/.test(error.message))
  assert.deepEqual(await readdir(join(root,'face-references','incoming')),[])
})
