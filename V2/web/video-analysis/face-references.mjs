import {createHash,randomUUID} from 'node:crypto'
import {mkdir,readFile,writeFile,open,lstat,stat,realpath,readdir,unlink,mkdtemp,rmdir} from 'node:fs/promises'
import path from 'node:path'
import {replaceIndex} from './atomic-index.mjs'
import {validChannelId} from './channels.mjs'
import {prepareFacePhoto,extractFaceCandidates} from './facecap-media.mjs'

export const FACE_REFERENCE_LIMITS=Object.freeze({maxPhotoBytes:8*1024**2,maxVideoBytes:80*1024**2,maxImageBytes:512*1024,maxCandidatesPerJob:12,maxReferencesPerChannel:120,maxSelectedReferences:9,maxStorageBytes:128*1024**2,maxPackBytes:12*1024**2})
const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/
const ANGLES=new Set(['unspecified','front','left','right','outfit','other'])
const stores=new Map(),maxIndexBytes=4*1024**2
const clone=value=>JSON.parse(JSON.stringify(value))
const fail=(message,status=422,code='face_reference_invalid')=>Object.assign(new Error(message),{status,code})
const inside=(root,value)=>{const relative=path.relative(root,value);return relative!==''&&!relative.startsWith(`..${path.sep}`)&&relative!=='..'&&!path.isAbsolute(relative)}
const text=(value,max=200)=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,max):''
const channel=value=>{if(!validChannelId(value))throw fail('Choose a valid saved channel.',404,'face_reference_not_found');return value}
const identifier=value=>{if(typeof value!=='string'||!UUID.test(value))throw fail('Reference not found.',404,'face_reference_not_found');return value}
const digest=bytes=>createHash('sha256').update(bytes).digest('hex')
const generation=()=>({available:false,provider:'siliconflow',model:'MiniMaxAI/MiniMax-H3',supportsReferenceImages:false,reason:'The current generation adapter uses text-to-video. These images can be exported, but are not sent to a generation provider.'})

function jpeg(value,width,height) {
  if(typeof value!=='string'||!value.length||value.length>Math.ceil(FACE_REFERENCE_LIMITS.maxImageBytes/3)*4||value.length%4||!/^[A-Za-z0-9+/]+={0,2}$/.test(value))throw fail('The photo processor returned invalid image data.',502,'face_reference_output')
  const bytes=Buffer.from(value,'base64')
  if(bytes.length<16||bytes.length>FACE_REFERENCE_LIMITS.maxImageBytes||bytes.toString('base64')!==value||bytes[0]!==255||bytes[1]!==216||bytes[2]!==255||bytes.at(-2)!==255||bytes.at(-1)!==217)throw fail('The photo processor returned an unsupported image.',502,'face_reference_output')
  let dimensions
  for(let cursor=2;cursor+4<=bytes.length;) {
    if(bytes[cursor++]!==255)break
    while(bytes[cursor]===255)cursor++
    const marker=bytes[cursor++]
    if(marker===0xda||marker===0xd9||cursor+2>bytes.length)break
    const length=bytes.readUInt16BE(cursor)
    if(length<2||cursor+length>bytes.length)break
    if([0xc0,0xc1,0xc2].includes(marker)&&length>=8){dimensions={height:bytes.readUInt16BE(cursor+3),width:bytes.readUInt16BE(cursor+5)};break}
    cursor+=length
  }
  if(!dimensions||!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>4096||height>4096||dimensions.width!==width||dimensions.height!==height)throw fail('The photo processor returned invalid image dimensions.',502,'face_reference_output')
  return bytes
}

function candidates(result,{durationSeconds}={}) {
  if(!result||!Array.isArray(result.candidates)||result.candidates.length>FACE_REFERENCE_LIMITS.maxCandidatesPerJob)throw fail('The photo processor returned too many or invalid reference candidates.',502,'face_reference_output')
  return result.candidates.map(value=>{
    if(!value||typeof value!=='object'||!['face','manual'].includes(value.detection))throw fail('The photo processor returned an invalid reference candidate.',502,'face_reference_output')
    const image=jpeg(value.imageBase64,value.width,value.height),context=jpeg(value.contextBase64,value.contextWidth,value.contextHeight)
    if(durationSeconds!==undefined&&(!Number.isFinite(value.sourceTimeSeconds)||value.sourceTimeSeconds<0||value.sourceTimeSeconds>durationSeconds+.02))throw fail('The photo processor returned invalid frame timing.',502,'face_reference_output')
    const quality={}
    if(Number.isFinite(value.quality?.sharpness)&&value.quality.sharpness>=0&&value.quality.sharpness<=1e12)quality.sharpness=value.quality.sharpness
    if(Number.isFinite(value.quality?.brightness)&&value.quality.brightness>=0&&value.quality.brightness<=1)quality.brightness=value.quality.brightness
    const box=value.cropBox
    const cropBox=box&&['x','y','width','height'].every(key=>Number.isFinite(box[key])&&box[key]>=0&&box[key]<=1)&&box.width>0&&box.height>0&&box.x+box.width<=1.001&&box.y+box.height<=1.001?{x:box.x,y:box.y,width:box.width,height:box.height}:undefined
    return {image,context,width:value.width,height:value.height,contextWidth:value.contextWidth,contextHeight:value.contextHeight,detection:value.detection,...(cropBox?{cropBox}:{}),...(durationSeconds!==undefined?{sourceTimeSeconds:Math.min(value.sourceTimeSeconds,durationSeconds)}:{}),...(Object.keys(quality).length?{quality}:{})}
  })
}

// Minimal uncompressed ZIP writer. Fixed generated entry names never contain user paths.
let crcTable
function crc32(bytes) {
  crcTable||=Array.from({length:256},(_,value)=>{for(let i=0;i<8;i++)value=value&1?0xedb88320^(value>>>1):value>>>1;return value>>>0})
  let crc=0xffffffff;for(const value of bytes)crc=crcTable[(crc^value)&255]^(crc>>>8)
  return (crc^0xffffffff)>>>0
}
function zip(entries) {
  const local=[],central=[];let offset=0
  for(const {name,bytes}of entries){
    const filename=Buffer.from(name),checksum=crc32(bytes),header=Buffer.alloc(30),directory=Buffer.alloc(46)
    header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt16LE(33,12);header.writeUInt32LE(checksum,14);header.writeUInt32LE(bytes.length,18);header.writeUInt32LE(bytes.length,22);header.writeUInt16LE(filename.length,26)
    directory.writeUInt32LE(0x02014b50);directory.writeUInt16LE(20,4);directory.writeUInt16LE(20,6);directory.writeUInt16LE(0x800,8);directory.writeUInt16LE(33,14);directory.writeUInt32LE(checksum,16);directory.writeUInt32LE(bytes.length,20);directory.writeUInt32LE(bytes.length,24);directory.writeUInt16LE(filename.length,28);directory.writeUInt32LE(offset,42)
    local.push(header,filename,bytes);central.push(directory,filename);offset+=header.length+filename.length+bytes.length
  }
  const index=Buffer.concat(central),end=Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(index.length,12);end.writeUInt32LE(offset,16)
  return Buffer.concat([...local,index,end])
}

export function createFaceReferenceStore({root,getConfig,photoProcessor=prepareFacePhoto,videoProcessor=extractFaceCandidates}={}) {
  if(typeof root!=='string'||!root.trim()||root.includes('\0'))throw fail('Reference storage is unavailable.',503,'face_reference_storage')
  const workspace=path.resolve(root)
  if(stores.has(workspace)){const store=stores.get(workspace);store.configure({getConfig,photoProcessor,videoProcessor});return store}
  const directory=path.join(workspace,'face-references'),images=path.join(directory,'images'),incoming=path.join(directory,'incoming'),index=path.join(directory,'index.json')
  let records=[],loaded=false,serial=Promise.resolve(),configReader=getConfig,prepare=photoProcessor,extract=videoProcessor
  const exclusive=work=>{const operation=serial.then(work,work);serial=operation.catch(()=>{});return operation}
  async function safeDirectory(filename,parent) {
    await mkdir(filename,{recursive:true});const info=await lstat(filename),actual=await realpath(filename)
    if(info.isSymbolicLink()||!info.isDirectory()||parent&&!inside(await realpath(parent),actual))throw fail('Reference storage must stay inside its private workspace.',503,'face_reference_storage')
    return actual
  }
  async function checked(filename,{optional=false,parent=directory}={}) {
    try {
      const base=path.resolve(parent),target=path.resolve(filename)
      if(!inside(base,target))throw fail('Reference storage contains an unsupported file.',503,'face_reference_storage')
      for(let cursor=path.dirname(target);path.relative(base,cursor)!=='';cursor=path.dirname(cursor))if((await lstat(cursor)).isSymbolicLink())throw fail('Reference storage contains an unsupported link.',503,'face_reference_storage')
      const info=await lstat(filename)
      if(info.isSymbolicLink()||!info.isFile()||!inside(await realpath(parent),await realpath(filename)))throw fail('Reference storage contains an unsupported file.',503,'face_reference_storage')
      return info
    } catch(error){if(optional&&error.code==='ENOENT')return null;throw error}
  }
  async function storageBytes() {
    let total=0
    async function visit(folder){for(const entry of await readdir(folder,{withFileTypes:true})){const target=path.join(folder,entry.name),info=await lstat(target);if(info.isSymbolicLink())throw fail('Reference storage contains an unsupported link.',503,'face_reference_storage');if(info.isDirectory())await visit(target);else if(info.isFile())total+=info.size;if(total>FACE_REFERENCE_LIMITS.maxStorageBytes) return}}
    await visit(directory);return total
  }
  function validateRecord(value,seen) {
    if(!value||!UUID.test(value.id)||seen.has(value.id)||!validChannelId(value.channelId)||!ANGLES.has(value.angle)||typeof value.selected!=='boolean'||typeof value.label!=='string'||value.label.length>120||!['face','manual'].includes(value.detection)||!['photo','video'].includes(value.source?.kind)||!Number.isFinite(Date.parse(value.createdAt)))throw Error('invalid reference metadata')
    for(const asset of [value.asset,value.contextAsset])if(!asset||asset.backend!=='local'||typeof asset.key!=='string'||!new RegExp(`^face-references/${value.id}/(?:face|context)\\.jpg$`).test(asset.key)||!/^[a-f0-9]{64}$/.test(asset.sha256)||!Number.isInteger(asset.bytes)||asset.bytes<16||asset.bytes>FACE_REFERENCE_LIMITS.maxImageBytes)throw Error('invalid reference asset')
    seen.add(value.id);return value
  }
  async function load() {
    await safeDirectory(workspace);await safeDirectory(directory,workspace);await safeDirectory(images,directory);await safeDirectory(incoming,directory)
    if(loaded)return
    try {
      const info=await checked(index,{optional:true})
      if(info){if(info.size>maxIndexBytes)throw Error('oversized');const document=JSON.parse(await readFile(index,'utf8'));if(document.schemaVersion!==1||!Array.isArray(document.references)||document.references.length>3840)throw Error('invalid');const seen=new Set();records=document.references.map(value=>validateRecord(value,seen));for(const id of new Set(records.map(value=>value.channelId))){const group=records.filter(value=>value.channelId===id);if(group.length>FACE_REFERENCE_LIMITS.maxReferencesPerChannel||group.filter(value=>value.selected).length>FACE_REFERENCE_LIMITS.maxSelectedReferences)throw Error('invalid count')}}
      loaded=true
    }catch{throw fail('The reference bank could not be read. Existing files were preserved.',503,'face_reference_storage')}
  }
  async function persist() {
    const bytes=Buffer.from(JSON.stringify({schemaVersion:1,references:records})),prior=await checked(index,{optional:true})
    if(bytes.length>maxIndexBytes||await storageBytes()-(prior?.size||0)+bytes.length>FACE_REFERENCE_LIMITS.maxStorageBytes)throw fail('The reference bank has reached its 128 MiB limit.',507,'face_reference_storage_full')
    const temporary=path.join(directory,`.index-${randomUUID()}.tmp`)
    try{await writeFile(temporary,bytes,{flag:'wx',mode:0o600});await replaceIndex(temporary,index)}finally{await unlink(temporary).catch(()=>{})}
  }
  const imagePath=(id,context=false)=>path.join(images,`${identifier(id)}-${context?'context':'face'}.jpg`)
  const publicRecord=record=>clone(Object.fromEntries(['id','channelId','label','angle','selected','width','height','contextWidth','contextHeight','cropBox','createdAt','source','detection','quality','asset','contextAsset'].filter(key=>record[key]!==undefined).map(key=>[key,record[key]])))
  async function bank(id,warnings=[]) {
    return {references:records.filter(value=>value.channelId===id).map(publicRecord),storage:{backend:'local',cloudSynced:false,usedBytes:await storageBytes(),maxBytes:FACE_REFERENCE_LIMITS.maxStorageBytes,message:'Stored privately on this computer. These assets are not synced to cloud storage.'},generation:generation(),limits:{...FACE_REFERENCE_LIMITS},warnings}
  }
  function find(id){identifier(id);const record=records.find(value=>value.id===id);if(!record)throw fail('Reference not found.',404,'face_reference_not_found');return record}
  async function add(id,result,source) {
    const values=candidates(result,source.kind==='video'?{durationSeconds:source.durationSeconds}:{}),prior=records.slice(),written=[]
    if(records.filter(value=>value.channelId===id).length+values.length>FACE_REFERENCE_LIMITS.maxReferencesPerChannel)throw fail('This channel supports up to 120 reference images.',507,'face_reference_channel_full')
    const required=values.reduce((sum,value)=>sum+value.image.length+value.context.length,0)
    if(await storageBytes()+required>FACE_REFERENCE_LIMITS.maxStorageBytes)throw fail('The reference bank has reached its 128 MiB limit.',507,'face_reference_storage_full')
    try {
      for(const value of values){
        const identifier=randomUUID(),asset={key:`face-references/${identifier}/face.jpg`,sha256:digest(value.image),bytes:value.image.length,backend:'local'},contextAsset={key:`face-references/${identifier}/context.jpg`,sha256:digest(value.context),bytes:value.context.length,backend:'local'}
        for(const [filename,bytes]of [[imagePath(identifier),value.image],[imagePath(identifier,true),value.context]]){await writeFile(filename,bytes,{flag:'wx',mode:0o600});written.push(filename)}
        records.push({id:identifier,channelId:id,label:'',angle:'unspecified',selected:false,width:value.width,height:value.height,contextWidth:value.contextWidth,contextHeight:value.contextHeight,...(value.cropBox?{cropBox:value.cropBox}:{}),createdAt:new Date().toISOString(),source:source.kind==='photo'?{kind:'photo',filename:source.filename}:{kind:'video',sourceItemId:source.sourceItemId,timeSeconds:value.sourceTimeSeconds},detection:value.detection,...(value.quality?{quality:value.quality}:{}),asset,contextAsset})
      }
      await persist()
    }catch(error){records=prior;for(const filename of written)await unlink(filename).catch(()=>{});throw error}
    const warnings=(Array.isArray(result.warnings)?result.warnings:[]).slice(0,12).map(value=>text(value,500)).filter(Boolean)
    return bank(id,warnings)
  }
  const store={
    configure(options){if(options.getConfig)configReader=options.getConfig;if(options.photoProcessor)prepare=options.photoProcessor;if(options.videoProcessor)extract=options.videoProcessor},
    async list(id){channel(id);return exclusive(async()=>{await load();return bank(id)})},
    async upload(id,stream,{filename,contentLength,contentType}={}) {
      channel(id)
      if(typeof filename!=='string'||!filename.trim()||filename.length>240||/[\\/\0\r\n]/.test(filename))throw fail('Choose a photo filename.')
      const mime=typeof contentType==='string'?contentType.split(';')[0].trim().toLowerCase():''
      if(mime&&!['image/jpeg','image/png','image/webp','image/gif','image/bmp','image/tiff','image/avif','image/heic','image/heif','application/octet-stream'].includes(mime))throw fail('Choose a supported photo file.',415)
      if(contentLength!==undefined&&(!Number.isSafeInteger(contentLength)||contentLength<1))throw fail('Invalid photo size.',400)
      if(contentLength>FACE_REFERENCE_LIMITS.maxPhotoBytes)throw fail('Photos must be 8 MiB or smaller.',413,'face_reference_upload_limit')
      return exclusive(async()=>{
        await load()
        if(records.filter(value=>value.channelId===id).length>=FACE_REFERENCE_LIMITS.maxReferencesPerChannel)throw fail('This channel supports up to 120 reference images.',507,'face_reference_channel_full')
        if(await storageBytes()+(contentLength||FACE_REFERENCE_LIMITS.maxPhotoBytes)>FACE_REFERENCE_LIMITS.maxStorageBytes)throw fail('The reference bank has reached its 128 MiB limit.',507,'face_reference_storage_full')
        const temporary=await mkdtemp(path.join(incoming,'photo-')),file=path.join(temporary,'photo.input');let handle,bytes=0
        try {
          await safeDirectory(temporary,incoming);handle=await open(file,'wx',0o600)
          const iterable=typeof stream?.iterator==='function'?stream.iterator({destroyOnReturn:false}):stream
          for await(const part of iterable){bytes+=Buffer.byteLength(part);if(bytes>FACE_REFERENCE_LIMITS.maxPhotoBytes||contentLength!==undefined&&bytes>contentLength)throw fail('Photos must be 8 MiB or smaller.',413,'face_reference_upload_limit');await handle.writeFile(part)}
          await handle.close();handle=null
          if(!bytes||contentLength!==undefined&&bytes!==contentLength)throw fail('The photo upload was empty or incomplete.',400,'face_reference_incomplete_upload')
          let result
          try{result=await prepare({filePath:file,config:await configReader?.()||{},signal:AbortSignal.timeout(90000)})}catch{throw fail('This photo could not be prepared. Try a JPEG, PNG or WebP photo.',422,'face_reference_processing')}
          await unlink(file)
          return await add(id,result,{kind:'photo',filename:text(filename,240)})
        }finally{await handle?.close().catch(()=>{});await unlink(file).catch(()=>{});await rmdir(temporary).catch(()=>{})}
      })
    },
    async capture(id,{filePath,sourceItemId,durationSeconds}={}) {
      channel(id);identifier(sourceItemId)
      if(typeof filePath!=='string'||!path.isAbsolute(filePath)||filePath.includes('\0')||!Number.isFinite(durationSeconds)||durationSeconds<=0||durationSeconds>300)throw fail('Choose a saved video of five minutes or less.')
      return exclusive(async()=>{
        await load();await checked(filePath,{parent:workspace});const info=await stat(filePath)
        if(info.size<=0||info.size>FACE_REFERENCE_LIMITS.maxVideoBytes)throw fail('Local face-reference capture supports saved videos of 80 MiB or less.',413,'face_reference_video_limit')
        if(records.filter(value=>value.channelId===id).length>=FACE_REFERENCE_LIMITS.maxReferencesPerChannel)throw fail('This channel supports up to 120 reference images.',507,'face_reference_channel_full')
        let result
        try{result=await extract({filePath,durationSeconds,config:await configReader?.()||{},signal:AbortSignal.timeout(120000)})}catch{throw fail('Reference frames could not be extracted from this video.',422,'face_reference_processing')}
        return add(id,result,{kind:'video',sourceItemId,durationSeconds})
      })
    },
    async update(id,value) {
      identifier(id)
      if(!value||typeof value!=='object'||Array.isArray(value)||!Object.keys(value).length||Object.keys(value).some(key=>!['selected','angle','label'].includes(key))||value.selected!==undefined&&typeof value.selected!=='boolean'||value.angle!==undefined&&!ANGLES.has(value.angle)||value.label!==undefined&&(typeof value.label!=='string'||value.label.length>120||/[\u0000-\u001f\u007f]/.test(value.label)))throw fail('Use a selection, angle or short label for this reference.',400)
      return exclusive(async()=>{
        await load();const record=find(id),previous=clone(record)
        if(value.selected===true&&!record.selected&&records.filter(item=>item.channelId===record.channelId&&item.selected).length>=FACE_REFERENCE_LIMITS.maxSelectedReferences)throw fail('Select up to nine references for one character pack.',409,'face_reference_selection_limit')
        Object.assign(record,value.label!==undefined?{...value,label:value.label.trim()}:value)
        try{await persist()}catch(error){Object.assign(record,previous);throw error}
        return publicRecord(record)
      })
    },
    async image(id,{context=false}={}) {
      identifier(id);if(typeof context!=='boolean')throw fail('Choose a valid reference image.',400)
      return exclusive(async()=>{await load();const record=find(id),filename=imagePath(id,context),info=await checked(filename,{parent:images}),asset=context?record.contextAsset:record.asset
        if(info.size!==asset.bytes||info.size>FACE_REFERENCE_LIMITS.maxImageBytes)throw fail('Reference image is unavailable.',404,'face_reference_not_found')
        const bytes=await readFile(filename);if(digest(bytes)!==asset.sha256)throw fail('Reference image is unavailable.',404,'face_reference_not_found')
        return {filePath:filename,size:info.size,contentType:'image/jpeg'}
      })
    },
    async exportPack(id) {
      channel(id)
      return exclusive(async()=>{
        await load();const selected=records.filter(value=>value.channelId===id&&value.selected)
        if(!selected.length)throw fail('Select at least one reference image to export.',409,'face_reference_selection_required')
        if(selected.length>FACE_REFERENCE_LIMITS.maxSelectedReferences)throw fail('Select up to nine references for one character pack.',409,'face_reference_selection_limit')
        const entries=[],references=[]
        for(const [position,record]of selected.entries()){
          const folder=`reference-${String(position+1).padStart(2,'0')}-${record.id}`
          for(const context of [false,true]){const filename=imagePath(record.id,context),info=await checked(filename,{parent:images}),asset=context?record.contextAsset:record.asset;if(info.size!==asset.bytes||info.size>FACE_REFERENCE_LIMITS.maxImageBytes)throw fail('A selected image is unavailable.',404,'face_reference_not_found');const bytes=await readFile(filename);if(digest(bytes)!==asset.sha256)throw fail('A selected image is unavailable.',404,'face_reference_not_found');entries.push({name:`${folder}/${context?'context':'face'}.jpg`,bytes})}
          references.push({...publicRecord(record),files:{face:`${folder}/face.jpg`,context:`${folder}/context.jpg`}})
        }
        entries.unshift({name:'manifest.json',bytes:Buffer.from(JSON.stringify({schemaVersion:1,channelId:id,createdAt:new Date().toISOString(),source:'User-selected visual references; no automatic identity recognition.',storage:{backend:'local',cloudSynced:false},generation:generation(),references},null,2))})
        const bytes=zip(entries)
        if(bytes.length>FACE_REFERENCE_LIMITS.maxPackBytes)throw fail('The selected reference pack exceeds 12 MiB. Select fewer images.',413,'face_reference_export_limit')
        return {bytes,contentType:'application/zip',filename:`spur-face-references-${id}.zip`}
      })
    },
  }
  stores.set(workspace,store);return store
}
