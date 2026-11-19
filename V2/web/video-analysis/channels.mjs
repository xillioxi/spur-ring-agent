import {mkdir,readFile,writeFile,rename,unlink,lstat,realpath,stat,readdir} from 'node:fs/promises'
import {join,relative,isAbsolute,basename} from 'node:path'
import {randomUUID,createHash} from 'node:crypto'
import {replaceIndex} from './atomic-index.mjs'

const reserved=new Set(['accounts','about','api','audio','challenge','developer','direct','directory','emails','explore','graphql','legal','oauth','p','privacy','reel','reels','share','stories','terms','tv','web'])
const validHandle=value=>typeof value==='string'&&/^(?!\.)(?!.*\.\.)(?!.*\.$)[a-z0-9_.]{1,30}$/i.test(value)&&!reserved.has(value.toLowerCase())
const inside=(root,path)=>{const part=relative(root,path);return !part.startsWith('..')&&!isAbsolute(part)}
const clone=value=>JSON.parse(JSON.stringify(value))
const now=()=>new Date().toISOString()
const defaultError=(message,status=422,code='invalid_request')=>Object.assign(new Error(message),{status,code})
export const CHANNEL_STYLE_DEFAULTS=Object.freeze({direction:'',format:'',editing:'',voice:'',generationMethod:'auto',generationNotes:''})
export const CHANNEL_SEEDS=Object.freeze(['dreamcode_films','gdarusa'])
export const CHANNEL_DISCOVERY_LIMITS=Object.freeze({maxCatalogVideos:10000,maxIndexBytes:16*1024*1024,maxPagesPerRun:1000,maxRunMs:10*60*1000,maxWorkspaceBytes:2*1024*1024*1024})
const discoveryQueue=[]
let discoveryActive=false
const discoveryIdleWaiters=new Set()
async function drainDiscovery(){
  if(discoveryActive)return
  discoveryActive=true
  try{while(discoveryQueue.length){try{await discoveryQueue.shift()()}catch{/* Each job saves its own failure. */}}}
  finally{discoveryActive=false;for(const done of discoveryIdleWaiters)done();discoveryIdleWaiters.clear()}
}
export function waitForChannelDiscoveryIdle(){return !discoveryActive&&!discoveryQueue.length?Promise.resolve():new Promise(done=>discoveryIdleWaiters.add(done))}

export function instagramChannel(input) {
  if(typeof input!=='string'||input.length>2048) throw defaultError('Paste a public Instagram channel link.')
  let url
  try{url=new URL(input)}catch{throw defaultError('Paste a public Instagram channel link.')}
  const parts=url.pathname.split('/').filter(Boolean)
  if(url.protocol!=='https:'||!['www.instagram.com','instagram.com'].includes(url.hostname)||url.username||url.password||url.port||url.hash||url.search||parts.length!==1||url.pathname.includes('//')||!validHandle(parts[0])) throw defaultError('Paste an Instagram profile link, such as instagram.com/creator/.')
  const handle=parts[0].toLowerCase()
  return {id:`instagram-${handle}`,platform:'instagram',handle,name:handle,url:`https://www.instagram.com/${handle}/`}
}
export function videoChannel(input) {
  let url
  try { url=new URL(input) } catch { throw defaultError('Paste an Instagram or TikTok creator profile link.') }
  if(['tiktok.com','www.tiktok.com','m.tiktok.com'].includes(url.hostname)) {
    const match=url.pathname.match(/^\/@([a-z0-9_.]{1,30})\/?$/i)
    if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash||!match||!validHandle(match[1]))throw defaultError('Paste a TikTok creator profile link, such as tiktok.com/@creator.')
    const handle=match[1].toLowerCase()
    return {id:`tiktok-${handle}`,platform:'tiktok',handle,name:handle,url:`https://www.tiktok.com/@${handle}`}
  }
  return instagramChannel(input)
}
const videoCode=value=>{const url=new URL(value);return url.hostname.endsWith('tiktok.com')?url.pathname.split('/').filter(Boolean).at(-1):url.pathname.split('/').filter(Boolean)[1]}
export function knownSourceChannel(source) {
  if(!source||typeof source!=='object') return null
  const isTikTok=value=>{try{return ['tiktok.com','www.tiktok.com','m.tiktok.com'].includes(new URL(value).hostname)}catch{return false}}
  if(validHandle(source.creatorHandle)&&[source.url,source.profileUrl,source.requestedUrl].some(isTikTok))return videoChannel(`https://www.tiktok.com/@${source.creatorHandle}`)
  const isInstagram=value=>{try{return ['instagram.com','www.instagram.com'].includes(new URL(value).hostname)}catch{return false}}
  if(validHandle(source.creatorHandle)&&[source.url,source.profileUrl,source.requestedUrl].some(isInstagram)) return instagramChannel(`https://www.instagram.com/${source.creatorHandle}/`)
  for(const key of ['profileUrl','requestedUrl','url']) {try{return videoChannel(source[key])}catch{/* Individual video URLs do not establish their owner. */}}
  return null
}
export function validChannelId(id) {return typeof id==='string'&&/^(instagram|tiktok)-/.test(id)&&validHandle(id.replace(/^(instagram|tiktok)-/,''))&&id===id.toLowerCase()}
export function sourceChannelId(source) {return knownSourceChannel(source)?.id||(validChannelId(source?.channelId)?source.channelId:null)}
function normalizeStyle(value,fail) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!Object.hasOwn(CHANNEL_STYLE_DEFAULTS,key))) throw fail('Provide only channel style fields.',400)
  const next={}
  for(const [key,text] of Object.entries(value)) {
    if(key==='generationMethod') {if(!['auto','ai_video','footage_edit','hybrid'].includes(text))throw fail('Choose a supported generation method.');next[key]=text;continue}
    if(typeof text!=='string'||text.length>(key==='generationNotes'?4000:1200)||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw fail('Channel style text is too long or contains unsupported characters.')
    next[key]=text.trim()
  }
  return next
}
function catalog(values,owner) {
  const seen=new Set(),result=[]
  for(const entry of (Array.isArray(values)?values:[]).slice(0,CHANNEL_DISCOVERY_LIMITS.maxCatalogVideos+1)) {
    if(!entry||typeof entry.url!=='string')continue
    let url
    try{url=new URL(entry.url)}catch{continue}
    if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash)continue
    const tiktok=['www.tiktok.com','tiktok.com'].includes(url.hostname),match=url.pathname.match(/^\/@([a-z0-9_.]{1,30})\/video\/(\d{10,25})\/?$/i)
    if(tiktok?(!match||owner?.platform==='instagram'||owner&&match[1].toLowerCase()!==owner.handle):(!['www.instagram.com','instagram.com'].includes(url.hostname)||owner?.platform==='tiktok'||!/^\/(?:reel|p|tv)\/[a-z0-9_-]{1,64}\/?$/i.test(url.pathname)))continue
    const canonical=tiktok?`https://www.tiktok.com/@${match[1].toLowerCase()}/video/${match[2]}`:`https://www.instagram.com${url.pathname.replace(/\/$/,'')}/`,code=videoCode(canonical)
    if(seen.has(code))continue
    seen.add(code)
    const item={url:canonical,title:typeof entry.title==='string'?entry.title.slice(0,240):'Reference video'}
    if(typeof entry.thumbnailUrl==='string'&&entry.thumbnailUrl.length<=4096){try{const image=new URL(entry.thumbnailUrl);if(image.protocol==='https:'&&!image.username&&!image.password)item.thumbnailUrl=image.href}catch{}}
    if(typeof entry.publishedAt==='string'&&Number.isFinite(Date.parse(entry.publishedAt))) item.publishedAt=new Date(entry.publishedAt).toISOString()
    if(Number.isFinite(entry.durationSeconds)&&entry.durationSeconds>0)item.durationSeconds=entry.durationSeconds
    result.push(item)
  }
  return result
}
function publicChannel(channel) {
  const {avatarFile,avatarContentType,avatarSourceUrl,...value}=channel
  if(avatarFile)value.avatarUrl=`/api/creator-agent/video-analysis/channels/${channel.id}/avatar?v=${encodeURIComponent(channel.avatarVersion||'1')}`
  value.discoveredVideos=(channel.discoveredVideos||[]).map(video=>({...video,...(video.thumbnailUrl?{thumbnailUrl:`/api/creator-agent/video-analysis/channels/${channel.id}/thumbnail?video=${encodeURIComponent(videoCode(video.url))}`}:{})}))
  if(value.discovery){const {nextCursor,cursorHashes,...discovery}=value.discovery;value.discovery={...discovery,discoveredCount:value.discoveredVideos.length,resumable:!!nextCursor&&discovery.status!=='complete'}}
  return clone(value)
}
export function channelObservations(items,id) {
  const references=items.filter(item=>item.source?.kind!=='reconstruction'&&sourceChannelId(item.source)===id&&(item.mediaFile||item.hasMedia||item.result)),analyzed=references.filter(item=>item.result),shots=analyzed.flatMap(item=>item.result?.shots||[])
  const durations=shots.map(shot=>Number(shot.endSeconds)-Number(shot.startSeconds)).filter(value=>Number.isFinite(value)&&value>0).sort((a,b)=>a-b)
  const common=key=>{const count=new Map();for(const shot of shots){const text=typeof shot[key]==='string'?shot[key].trim():'';if(text)count.set(text,(count.get(text)||0)+1)}return [...count].sort((a,b)=>b[1]-a[1]).slice(0,3).map(([text])=>text)}
  const visualExamples=analyzed.flatMap(item=>(item.result?.shots||[]).filter(shot=>typeof shot.visual==='string'&&shot.visual.trim()).slice(0,1).map(shot=>({itemId:item.id,title:item.title,text:shot.visual.slice(0,500)}))).slice(0,3)
  return {referenceCount:references.length,analyzedCount:analyzed.length,partialCount:analyzed.filter(item=>item.result.status==='partial'||item.status==='partial').length,shotCount:shots.length,...(durations.length?{medianShotSeconds:Number(((durations[Math.floor((durations.length-1)/2)]+durations[Math.floor(durations.length/2)])/2).toFixed(2))}:{}),commonFraming:common('framing'),commonCameraMovement:common('cameraMovement'),speechVideoCount:analyzed.filter(item=>item.result?.script?.text?.trim()).length,onScreenTextVideoCount:analyzed.filter(item=>item.result?.script?.onScreenText?.length).length,visualExamples,sampleBasis:'Saved video analyses in this channel library; observations are estimates, not a trained generation model.'}
}

export function createChannelStore({root,discover,discoverPage,fetchImage,createError=defaultError}) {
  const fail=createError,index=join(root,'channels.json'),images=join(root,'channel-images')
  let records=[],loaded=false,serial=Promise.resolve(),currentDiscover=discover,currentDiscoverPage=discoverPage,currentFetchImage=fetchImage
  const pendingSyncs=new Map()
  const pendingDiscovery=new Set()
  const thumbnailCache=new Map()
  const exclusive=work=>{const result=serial.then(work,work);serial=result.catch(()=>{});return result}
  async function checkIndex() {
    try{const info=await lstat(index);if(info.isSymbolicLink()||!info.isFile()||info.size>CHANNEL_DISCOVERY_LIMITS.maxIndexBytes||!inside(await realpath(root),await realpath(index)))throw fail('Channel storage could not be read. Existing files were preserved.',503,'storage_unavailable');return info}catch(error){if(error.code==='ENOENT')return null;throw error}
  }
  async function workspaceBytes(directory){let bytes=0;for(const entry of await readdir(directory,{withFileTypes:true})){if(entry.isSymbolicLink())throw fail('Channel storage contains an unsupported symbolic link.',503,'storage_unavailable');const path=join(directory,entry.name);if(entry.isDirectory())bytes+=await workspaceBytes(path);else if(entry.isFile())bytes+=(await stat(path)).size}return bytes}
  async function persist(){
    const previous=await checkIndex()
    const text=JSON.stringify({schemaVersion:1,channels:records})
    if(Buffer.byteLength(text)>CHANNEL_DISCOVERY_LIMITS.maxIndexBytes||records.reduce((sum,record)=>sum+(record.discoveredVideos?.length||0),0)>CHANNEL_DISCOVERY_LIMITS.maxCatalogVideos)throw fail('The channel catalog has reached its storage limit. Existing references were preserved.',507,'storage_full')
    if(await workspaceBytes(root)-(previous?.size||0)+Buffer.byteLength(text)>CHANNEL_DISCOVERY_LIMITS.maxWorkspaceBytes)throw fail('The video workspace has reached its 2 GiB limit. Existing references were preserved.',507,'storage_full')
    const temp=join(root,`.channels-${randomUUID()}.tmp`)
    try{await writeFile(temp,text,{flag:'wx',mode:0o600});await replaceIndex(temp,index)}finally{await unlink(temp).catch(()=>{})}
  }
  async function load(){
    if(loaded)return
    await mkdir(root,{recursive:true});await mkdir(images,{recursive:true})
    if((await lstat(images)).isSymbolicLink()||!inside(await realpath(root),await realpath(images)))throw fail('Channel images must stay inside their workspace.',503,'storage_unavailable')
    try{
      const info=await checkIndex()
      if(info){const data=JSON.parse(await readFile(index,'utf8'));if(data.schemaVersion!==1||!Array.isArray(data.channels)||data.channels.length>32)throw Error('invalid');const seen=new Set();records=data.channels.map(record=>{if(!validChannelId(record?.id)||seen.has(record.id)||videoChannel(record.url).id!==record.id||record.avatarFile&&(basename(record.avatarFile)!==record.avatarFile||!/^(?:instagram|tiktok)-[a-z0-9_.-]+\.(?:jpg|png|webp)$/.test(record.avatarFile)))throw Error('invalid');seen.add(record.id);const discovery=record.discovery&&typeof record.discovery==='object'?record.discovery:{status:'idle',pagesFetched:0,updatedAt:record.updatedAt};if(discovery.status==='running'){discovery.status='partial';discovery.message='Discovery was interrupted by a restart. Resume to continue from the saved page.';discovery.updatedAt=now()}return {...record,style:{...CHANNEL_STYLE_DEFAULTS,...normalizeStyle(record.style||{},fail)},discoveredVideos:catalog(record.discoveredVideos,record),discovery}});if(records.reduce((sum,record)=>sum+record.discoveredVideos.length,0)>CHANNEL_DISCOVERY_LIMITS.maxCatalogVideos)throw Error('invalid')}
    }catch(error){throw fail('Channel storage could not be read. Existing files were preserved.',503,'storage_unavailable')}
    for(const handle of CHANNEL_SEEDS)if(!records.some(record=>record.id===`instagram-${handle}`)){const timestamp=now();records.push({...instagramChannel(`https://www.instagram.com/${handle}/`),discoveredVideos:[],style:{...CHANNEL_STYLE_DEFAULTS},discovery:{status:'idle',pagesFetched:0,updatedAt:timestamp},catalogComplete:false,createdAt:timestamp,updatedAt:timestamp})}
    loaded=true;await persist()
  }
  function find(id){if(!validChannelId(id))throw fail('Channel not found.',404,'not_found');const record=records.find(value=>value.id===id);if(!record)throw fail('Channel not found.',404,'not_found');return record}
  async function ensure(input){
    let identity;try{identity=videoChannel(input)}catch(error){throw fail(error.message,error.status)}
    return exclusive(async()=>{await load();const existing=records.find(record=>record.id===identity.id);if(existing)return publicChannel(existing);if(records.length>=32)throw fail('The workspace supports up to 32 channels.',507,'storage_full');const timestamp=now(),record={...identity,discoveredVideos:[],style:{...CHANNEL_STYLE_DEFAULTS},discovery:{status:'idle',pagesFetched:0,updatedAt:timestamp},catalogComplete:false,createdAt:timestamp,updatedAt:timestamp};records.push(record);try{await persist()}catch(error){records.pop();throw error}return publicChannel(record)})
  }
  async function sync(id){
    if(pendingSyncs.has(id))return pendingSyncs.get(id)
    const work=(async()=>{
      const record=await exclusive(async()=>{await load();return clone(find(id))})
      let metadata,image,imageError
      try{
        if(!currentDiscover)throw fail('Public channel refresh is unavailable. You can still add individual videos.',503)
        const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),50_000)
        try{metadata=await currentDiscover({url:record.url,signal:controller.signal});if(!metadata||typeof metadata!=='object')throw fail('Instagram did not return channel metadata. Existing references were preserved.',502);if(metadata?.handle&&String(metadata.handle).toLowerCase()!==record.handle)throw fail('Instagram returned a different channel. Existing references were preserved.',502);if(metadata?.avatarUrl&&currentFetchImage){try{image=await currentFetchImage(metadata.avatarUrl,{signal:controller.signal})}catch{imageError='The channel was refreshed, but its profile image could not be loaded. Try refreshing later.'}}}finally{clearTimeout(timer)}
      }catch(error){return exclusive(async()=>{await load();const current=find(id);current.syncError=typeof error.message==='string'?error.message.slice(0,400):'The channel could not be refreshed.';current.updatedAt=now();await persist();return publicChannel(current)})}
      return exclusive(async()=>{
        await load();const current=find(id),previous=clone(current),timestamp=now()
        const videos=catalog(metadata.discoveredVideos||metadata.reels,current)
        const byUrl=new Map([...(current.discoveredVideos||[]),...videos].map(value=>[videoCode(value.url),value]))
        current.discoveredVideos=[...byUrl.values()]
        current.name=typeof metadata.name==='string'&&metadata.name.trim()?metadata.name.trim().slice(0,120):current.name
        current.lastSyncedAt=timestamp;current.updatedAt=timestamp;current.catalogComplete=current.discovery?.status==='complete';current.syncError=imageError
        if(current.platform==='tiktok'){current.catalogComplete=false;current.discovery={status:'partial',source:'tiktok_public_preview',requiresConnection:false,pagesFetched:1,updatedAt:timestamp,message:'Public preview refreshed. Up to 24 recent posts are listed; full channel coverage is not verified.'}}
        if(image&&Buffer.isBuffer(image.bytes)&&image.bytes.length>0&&image.bytes.length<=2*1024*1024){
          const extension={'image/jpeg':'jpg','image/png':'png','image/webp':'webp'}[image.contentType]
          if(extension){const filename=`${id}.${extension}`,target=join(images,filename),temp=join(images,`.avatar-${randomUUID()}.tmp`);try{const info=await lstat(target).catch(error=>{if(error.code==='ENOENT')return null;throw error});if(info?.isSymbolicLink())throw fail('Channel image storage is unavailable.',503,'storage_unavailable');await writeFile(temp,image.bytes,{flag:'wx',mode:0o600});await rename(temp,target);current.avatarFile=filename;current.avatarContentType=image.contentType;current.avatarVersion=String(Date.now());current.avatarSourceUrl=metadata.avatarUrl}finally{await unlink(temp).catch(()=>{})}}
        }
        try{await persist()}catch(error){records[records.indexOf(current)]=previous;throw error}
        return publicChannel(current)
      })
    })()
    pendingSyncs.set(id,work)
    try{return await work}finally{pendingSyncs.delete(id)}
  }
  async function saveDiscovery(id,change){
    return exclusive(async()=>{await load();const current=find(id),previous=clone(current);try{change(current);current.updatedAt=now();if(current.discovery){current.discovery.updatedAt=current.updatedAt;current.discovery.discoveredCount=current.discoveredVideos.length}await persist()}catch(error){records[records.indexOf(current)]=previous;throw error}return publicChannel(current)})
  }
  async function discoveryJob(id){
    const started=Date.now()
    let pagesThisRun=0
    try{
      for(;;){
        const record=await exclusive(async()=>{await load();return clone(find(id))})
        if(!currentDiscoverPage){await saveDiscovery(id,current=>{current.discovery.status='blocked';current.discovery.message='Full channel discovery needs a paginated Instagram connection. The public preview cannot verify the complete feed.';current.catalogComplete=false});return}
        if(pagesThisRun>=CHANNEL_DISCOVERY_LIMITS.maxPagesPerRun||Date.now()-started>=CHANNEL_DISCOVERY_LIMITS.maxRunMs){await saveDiscovery(id,current=>{current.discovery.status='partial';current.discovery.message='Discovery paused after reaching its processing budget. All discovered videos are saved; resume to continue.'});return}
        const controller=new AbortController()
        let timer,page
        try{
          page=await Promise.race([
            currentDiscoverPage({url:record.url,cursor:record.discovery.nextCursor,signal:controller.signal}),
            new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(fail('Instagram did not respond to the next page. Resume to try again.',504,'discovery_timeout'))},50_000)}),
          ])
        }finally{clearTimeout(timer)}
        if(!page||typeof page!=='object'||page.handle&&String(page.handle).toLowerCase()!==record.handle)throw fail('Instagram returned an unexpected channel page. Existing references were preserved.',502,'invalid_discovery_page')
        if(page.requiresConnection){await saveDiscovery(id,current=>{current.discovery.status='blocked';current.discovery.requiresConnection=true;current.discovery.message=typeof page.message==='string'?page.message.slice(0,600):'Connect Instagram to discover the complete channel feed.';current.catalogComplete=false});return}
        const videos=catalog(page.discoveredVideos||page.reels,record),pageInfo=page.pageInfo
        const paginated=(page.authoritative===true||page.coverage==='paginated')&&['instagram_public','instagram_authorized'].includes(page.source)
        let stop=false
        await saveDiscovery(id,current=>{
          const discovery=current.discovery,byCode=new Map(current.discoveredVideos.map(value=>[videoCode(value.url),value]))
          const remaining=CHANNEL_DISCOVERY_LIMITS.maxCatalogVideos-records.reduce((sum,value)=>sum+(value.id===id?0:value.discoveredVideos.length),0)
          let limited=false
          for(const video of videos){const code=videoCode(video.url);if(!byCode.has(code)&&byCode.size>=remaining){limited=true;break}byCode.set(code,video)}
          current.discoveredVideos=[...byCode.values()]
          if(typeof page.name==='string'&&page.name.trim())current.name=page.name.trim().slice(0,120)
          if(['instagram_public','instagram_authorized'].includes(page.source))discovery.source=page.source
          if(Number.isSafeInteger(page.totalCount)&&page.totalCount>=0)discovery.totalCount=page.totalCount
          discovery.pagesFetched=(discovery.pagesFetched||0)+1
          discovery.requiresConnection=false
          current.catalogComplete=false
          if(limited){discovery.status='partial';discovery.message=`The workspace catalog limit of ${CHANNEL_DISCOVERY_LIMITS.maxCatalogVideos.toLocaleString('en-US')} videos was reached. Existing references are saved; coverage is incomplete.`;stop=true;return}
          if(!paginated||!pageInfo||typeof pageInfo.hasNextPage!=='boolean'){
            if(current.platform==='tiktok'){discovery.status='partial';discovery.source='tiktok_public_preview';discovery.message='The public TikTok preview is saved. Full channel coverage is not verified.';discovery.requiresConnection=false;stop=true;return}
            discovery.status='blocked';discovery.message=typeof page.message==='string'?page.message.slice(0,600):'These videos came from a public preview. A paginated Instagram connection is required to verify the complete channel feed.';discovery.requiresConnection=true;stop=true;return
          }
          discovery.hasNextPage=pageInfo.hasNextPage
          if(!pageInfo.hasNextPage){
            if(Number.isSafeInteger(discovery.totalCount)&&current.discoveredVideos.length<discovery.totalCount){discovery.status='partial';discovery.message='The feed ended before its reported video count was reached. Saved references are available; retry discovery to check missing videos.';stop=true;return}
            discovery.status='complete';discovery.message='The end of the available channel feed was reached.';discovery.completedAt=now();delete discovery.nextCursor;current.catalogComplete=true;stop=true;return
          }
          if(typeof pageInfo.endCursor!=='string'||!pageInfo.endCursor||pageInfo.endCursor.length>4096)throw fail('Instagram did not provide a valid next-page cursor. Resume to try again.',502,'invalid_discovery_cursor')
          const digest=createHash('sha256').update(pageInfo.endCursor).digest('hex')
          if(discovery.cursorHashes?.includes(digest))throw fail('Instagram repeated a page cursor. Saved references were preserved; retry discovery later.',502,'repeated_discovery_cursor')
          discovery.nextCursor=pageInfo.endCursor;discovery.cursorHashes=[...(discovery.cursorHashes||[]),digest].slice(-10000)
          discovery.status='running';discovery.message=`Discovered ${current.discoveredVideos.length.toLocaleString('en-US')} videos. Loading the next page…`
        })
        pagesThisRun++
        if(stop)return
      }
    }catch(error){
      await saveDiscovery(id,current=>{
        const blocked=error.requiresConnection||[401,403,429].includes(error.status)||/connection_required|rate_limit|login_required/.test(error.code||'')
        current.discovery.status=blocked?'blocked':current.discovery.pagesFetched?'partial':'failed'
        current.discovery.requiresConnection=!!error.requiresConnection||/connection_required|login_required/.test(error.code||'')
        current.discovery.message=typeof error.message==='string'?error.message.slice(0,600):'Channel discovery could not finish. Existing references were preserved.'
        current.catalogComplete=false
      }).catch(async()=>{
        // If even a short status update cannot be written, report the failure
        // in this process while leaving the last durable checkpoint untouched.
        await exclusive(async()=>{const current=find(id);current.catalogComplete=false;current.discovery={...current.discovery,status:'partial',message:'Discovery paused because its progress could not be saved. Existing references were preserved.',updatedAt:now()}}).catch(()=>{})
      })
    }finally{pendingDiscovery.delete(id)}
  }
  async function startDiscovery(id,{resume=true}={}){
    if(typeof resume!=='boolean')throw fail('Choose whether to resume discovery.',400)
    return exclusive(async()=>{
      await load();const current=find(id)
      if(pendingDiscovery.has(id))return publicChannel(current)
      const previous=clone(current),timestamp=now(),prior=current.discovery||{},continueRun=resume&&prior.status!=='complete'
      current.discovery={...(continueRun?prior:{}),status:'running',pagesFetched:continueRun?(prior.pagesFetched||0):0,discoveredCount:current.discoveredVideos.length,startedAt:timestamp,updatedAt:timestamp,message:'Waiting to discover the channel feed…'}
      delete current.discovery.completedAt;current.catalogComplete=false;current.updatedAt=timestamp
      try{await persist()}catch(error){records[records.indexOf(current)]=previous;throw error}
      pendingDiscovery.add(id);discoveryQueue.push(()=>discoveryJob(id));setImmediate(drainDiscovery)
      return publicChannel(current)
    })
  }
  return {
    configure(next){currentDiscover=next.discover;currentDiscoverPage=next.discoverPage;currentFetchImage=next.fetchImage},ensure,sync,startDiscovery,
    whenDiscoveryIdle:waitForChannelDiscoveryIdle,
    async list(){return exclusive(async()=>{await load();return records.map(publicChannel)})},
    async get(id){return exclusive(async()=>{await load();return publicChannel(find(id))})},
    async update(id,{style}={}){const patch=normalizeStyle(style,fail);return exclusive(async()=>{await load();const current=find(id),previous=clone(current);current.style={...current.style,...patch};current.updatedAt=now();try{await persist()}catch(error){records[records.indexOf(current)]=previous;throw error}return publicChannel(current)})},
    async avatar(id){return exclusive(async()=>{await load();const current=find(id);if(!current.avatarFile)throw fail('This channel image is not available yet. Refresh the channel.',404,'not_found');const filePath=join(images,current.avatarFile),info=await lstat(filePath).catch(()=>null);if(!info?.isFile()||info.isSymbolicLink()||!inside(await realpath(images),await realpath(filePath)))throw fail('Channel image is unavailable.',404,'not_found');return {filePath,size:(await stat(filePath)).size,contentType:current.avatarContentType||'image/jpeg'}})},
    async thumbnail(id,code){
      if(typeof code!=='string'||!/^[a-z0-9_-]{1,64}$/i.test(code))throw fail('Video preview not found.',404,'not_found')
      const source=await exclusive(async()=>{await load();const current=find(id);return current.discoveredVideos.find(video=>videoCode(video.url)===code)?.thumbnailUrl})
      if(!source||!currentFetchImage)throw fail('Video preview is unavailable.',404,'not_found')
      const cached=thumbnailCache.get(source);if(cached&&Date.now()-cached.at<15*60*1000)return cached.value
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20_000)
      let value;try{value=await currentFetchImage(source,{signal:controller.signal})}catch{throw fail('Video preview could not be loaded. Refresh the channel to update it.',404,'not_found')}finally{clearTimeout(timer)}
      if(!Buffer.isBuffer(value?.bytes)||value.bytes.length>2*1024*1024||!['image/jpeg','image/png','image/webp'].includes(value.contentType))throw fail('Video preview is unavailable.',404,'not_found')
      thumbnailCache.delete(source);thumbnailCache.set(source,{at:Date.now(),value});while(thumbnailCache.size>12)thumbnailCache.delete(thumbnailCache.keys().next().value)
      return value
    },
  }
}
