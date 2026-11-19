import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,readFile,writeFile,mkdir,symlink} from 'node:fs/promises'
import {join} from 'node:path'
import {createChannelStore,instagramChannel,videoChannel,knownSourceChannel,sourceChannelId,channelObservations,waitForChannelDiscoveryIdle,CHANNEL_DISCOVERY_LIMITS} from './channels.mjs'

test('TikTok creator identities are isolated from Instagram and linked by real source metadata', () => {
  assert.deepEqual(videoChannel('https://tiktok.com/@EZ_Home/?lang=en'), { id: 'tiktok-ez_home', platform: 'tiktok', handle: 'ez_home', name: 'ez_home', url: 'https://www.tiktok.com/@ez_home' })
  for (const url of ['https://tiktok.com/@ez_home/video/7014215295795498245', 'https://user:secret@tiktok.com/@ez_home', 'https://tiktok.com.evil.test/@ez_home', 'https://vm.tiktok.com/@ez_home']) assert.throws(() => videoChannel(url))
  assert.equal(knownSourceChannel({ url: 'https://www.tiktok.com/@ez_home/video/7014215295795498245', creatorHandle: 'ez_home' }).id, 'tiktok-ez_home')
  assert.equal(sourceChannelId({ kind: 'upload', channelId: 'tiktok-ez_home' }), 'tiktok-ez_home')
  assert.equal(videoChannel('https://instagram.com/ez_home/').id, 'instagram-ez_home')
})

test('TikTok catalogs, private thumbnails and style settings persist without mixing platforms or owners', async t => {
  const {root,store}=await fixture(t,{discover:async()=>({handle:'ez_home',name:'EZ Home',discoveredVideos:[
    {url:'https://www.tiktok.com/@ez_home/video/7014215295795498245?lang=en',title:'Build',thumbnailUrl:'https://p16.tiktokcdn-us.com/cover.jpg'},
    {url:'https://www.tiktok.com/@other/video/7014215295795498246',title:'Wrong owner'},
    {url:'https://www.instagram.com/reel/OTHER/',title:'Wrong platform'},
  ]}),fetchImage:async()=>({bytes:Buffer.from('image'),contentType:'image/jpeg'})})
  const channel=await store.ensure('https://www.tiktok.com/@ez_home')
  const synced=await store.sync(channel.id)
  assert.equal(synced.discoveredVideos.length,1)
  assert.match(synced.discoveredVideos[0].thumbnailUrl,/tiktok-ez_home\/thumbnail\?video=7014215295795498245$/)
  assert.equal((await store.thumbnail(channel.id,'7014215295795498245')).bytes.toString(),'image')
  assert.equal(synced.catalogComplete,false);assert.equal(synced.discovery.requiresConnection,false)
  await store.update(channel.id,{style:{direction:'Clear DIY demonstrations'}})
  const reloaded=await createChannelStore({root}).get(channel.id)
  assert.equal(reloaded.style.direction,'Clear DIY demonstrations');assert.equal(reloaded.discoveredVideos.length,1)
  assert.equal((await store.get('instagram-dreamcode_films')).style.direction,'')
})

async function fixture(t,extra={}){const root=await mkdtemp(join(process.cwd(),'.spur-channel-test-'));t.after(()=>rm(root,{recursive:true,force:true}));return {root,store:createChannelStore({root,...extra})}}
test('profile identity is canonical and never treats a reel, credentials or arbitrary host as a channel',()=>{
  assert.equal(instagramChannel('https://instagram.com/DreamCode_Films/').id,'instagram-dreamcode_films')
  for(const url of ['https://instagram.com/reel/abc/','https://evil.example/creator/','https://user:password@instagram.com/creator/','https://instagram.com/creator/?tracking=1','https://instagram.com/explore/','https://instagram.com/a..b/'])assert.throws(()=>instagramChannel(url),{status:422})
  assert.equal(knownSourceChannel({url:'https://instagram.com/reel/ABC/'}),null)
  assert.equal(knownSourceChannel({url:'https://instagram.com/reel/ABC/',profileUrl:'https://instagram.com/wrong/',creatorHandle:'actual_owner'}).id,'instagram-actual_owner')
  assert.equal(sourceChannelId({kind:'upload',channelId:'instagram-dreamcode_films'}),'instagram-dreamcode_films')
})
test('channel seeds do not make network calls and style preferences persist independently',async t=>{
  let calls=0;const {root,store}=await fixture(t,{discover:async()=>{calls++;throw Error('should not run')}})
  const channels=await store.list();assert.equal(channels.length,2);assert.equal(calls,0)
  const updated=await store.update(channels[0].id,{style:{direction:' Cinematic nights ',generationMethod:'hybrid',generationNotes:'Use my travel footage.'}})
  assert.equal(updated.style.direction,'Cinematic nights');assert.equal(updated.style.generationMethod,'hybrid')
  const fresh=createChannelStore({root});assert.equal((await fresh.get(channels[0].id)).style.generationNotes,'Use my travel footage.')
  assert.equal((await fresh.get(channels[1].id)).style.direction,'')
  await assert.rejects(store.update(channels[0].id,{style:{generationMethod:'imaginary'}}),{status:422})
  await assert.rejects(store.update(channels[0].id,{style:{unknown:'x'}}),{status:400})
})
test('sync stores real catalog metadata and private avatar bytes; refresh failure preserves references',async t=>{
  let fail=false,discoveryCalls=0
  const {store}=await fixture(t,{discover:async()=>{discoveryCalls++;if(fail)throw Error('Instagram temporarily limited public requests.');return {handle:'dreamcode_films',name:'Dreamcode Films',avatarUrl:'https://cdninstagram.com/avatar.jpg',discoveredVideos:[{url:'https://instagram.com/reel/REAL/',title:'A real reference',publishedAt:'2026-01-01'},{url:'https://evil.example/reel/FAKE/',title:'rejected'}]}},fetchImage:async()=>({bytes:Buffer.from('image-fixture'),contentType:'image/jpeg'})})
  const first=await store.sync('instagram-dreamcode_films')
  assert.equal(discoveryCalls,1);assert.equal(first.name,'Dreamcode Films');assert.equal(first.discoveredVideos.length,1);assert.equal(first.catalogComplete,false)
  assert.match(first.avatarUrl,/\/channels\/instagram-dreamcode_films\/avatar\?v=/);assert.equal(first.avatarFile,undefined);assert.equal(first.avatarSourceUrl,undefined)
  const avatar=await store.avatar(first.id);assert.equal(await readFile(avatar.filePath,'utf8'),'image-fixture')
  fail=true;const failed=await store.sync(first.id);assert.match(failed.syncError,/temporarily limited/);assert.equal(failed.discoveredVideos.length,1);assert.equal(failed.avatarUrl,first.avatarUrl)
})
test('schema and symbolic-link storage failures preserve existing channel data',async t=>{
  const {root}=await fixture(t);await writeFile(join(root,'channels.json'),'broken-json')
  await assert.rejects(createChannelStore({root}).list(),{status:503});assert.equal(await readFile(join(root,'channels.json'),'utf8'),'broken-json')
  const second=await fixture(t);await mkdir(join(second.root,'outside'));try{await symlink(join(second.root,'outside'),join(second.root,'channel-images'),'junction')}catch(error){if(['EPERM','EACCES'].includes(error.code))return;throw error}
  await assert.rejects(second.store.list(),{status:503})
})
test('observations only aggregate analyzed references owned by the selected channel',()=>{
  const items=[{id:'a',title:'A reference',source:{kind:'upload',channelId:'instagram-dreamcode_films'},result:{status:'partial',shots:[{startSeconds:0,endSeconds:2,visual:'Blue mountains',framing:'Wide'},{startSeconds:2,endSeconds:6,framing:'Wide'}],script:{text:'Travel begins.',onScreenText:[{text:'Travel'}]}}},{id:'b',source:{profileUrl:'https://instagram.com/gdarusa/'},result:{shots:[{startSeconds:0,endSeconds:999}],script:{text:'Other channel'}}},{id:'c',source:{kind:'upload',channelId:'instagram-dreamcode_films'}}]
  const value=channelObservations(items,'instagram-dreamcode_films');assert.equal(value.referenceCount,1);assert.equal(value.analyzedCount,1);assert.equal(value.partialCount,1);assert.equal(value.shotCount,2);assert.equal(value.medianShotSeconds,3);assert.deepEqual(value.commonFraming,['Wide']);assert.equal(value.visualExamples[0].text,'Blue mountains');assert.equal(value.speechVideoCount,1)
})

const video=code=>({url:`https://www.instagram.com/reel/${code}/`,title:`Video ${code}`})
const fullPage=(videos,hasNextPage,endCursor)=>({handle:'dreamcode_films',source:'instagram_authorized',coverage:'paginated',authoritative:true,discoveredVideos:videos,pageInfo:{hasNextPage,...(endCursor?{endCursor}:{})}})

test('full discovery traverses every page, keeps more than 100 references, and preserves channel style',async t=>{
  const calls=[]
  const {store}=await fixture(t,{discoverPage:async({cursor})=>{calls.push(cursor);return cursor?fullPage([video('V129'),...Array.from({length:130},(_,i)=>video(`V${i+130}`))],false):fullPage(Array.from({length:130},(_,i)=>video(`V${i}`)),true,'page-two')}})
  await store.update('instagram-dreamcode_films',{style:{direction:'Keep my direction',generationMethod:'hybrid'}})
  const accepted=await store.startDiscovery('instagram-dreamcode_films')
  assert.equal(accepted.discovery.status,'running')
  await waitForChannelDiscoveryIdle()
  const result=await store.get(accepted.id)
  assert.deepEqual(calls,[undefined,'page-two']);assert.equal(result.discoveredVideos.length,260)
  assert.equal(result.discovery.status,'complete');assert.equal(result.discovery.hasNextPage,false);assert.equal(result.discovery.pagesFetched,2);assert.equal(result.catalogComplete,true)
  assert.equal(result.style.direction,'Keep my direction');assert.equal(result.style.generationMethod,'hybrid')
  assert.equal(result.discovery.nextCursor,undefined);assert.equal(result.discovery.cursorHashes,undefined)
})

test('rate limits keep the last durable page and resume from its private cursor',async t=>{
  let limited=true;const calls=[]
  const {root,store}=await fixture(t,{discoverPage:async({cursor})=>{calls.push(cursor);if(!cursor)return fullPage([video('FIRST')],true,'opaque-private-cursor');if(limited)throw Object.assign(Error('Instagram temporarily limited requests.'),{status:429,code:'instagram_rate_limit'});return fullPage([video('SECOND')],false)}})
  await store.startDiscovery('instagram-dreamcode_films');await waitForChannelDiscoveryIdle()
  const blocked=await store.get('instagram-dreamcode_films')
  assert.equal(blocked.discovery.status,'blocked');assert.equal(blocked.discovery.resumable,true);assert.equal(blocked.discoveredVideos.length,1)
  assert.ok(!JSON.stringify(blocked).includes('opaque-private-cursor'))
  assert.ok((await readFile(join(root,'channels.json'),'utf8')).includes('opaque-private-cursor'))
  limited=false;await store.startDiscovery(blocked.id);await waitForChannelDiscoveryIdle()
  const done=await store.get(blocked.id)
  assert.deepEqual(calls,[undefined,'opaque-private-cursor','opaque-private-cursor']);assert.equal(done.discoveredVideos.length,2);assert.equal(done.discovery.status,'complete')
})

test('a public preview and a missing connection never claim complete channel coverage',async t=>{
  const {store}=await fixture(t,{discoverPage:async()=>({...fullPage([video('PREVIEW')],false),source:'instagram_public',authoritative:false,coverage:'preview'})})
  await store.startDiscovery('instagram-dreamcode_films');await waitForChannelDiscoveryIdle()
  const preview=await store.get('instagram-dreamcode_films')
  assert.equal(preview.discoveredVideos.length,1);assert.equal(preview.catalogComplete,false);assert.equal(preview.discovery.status,'blocked');assert.equal(preview.discovery.requiresConnection,true)
  store.configure({discoverPage:async()=>({requiresConnection:true,message:'Connect Instagram to load every page.'})})
  await store.startDiscovery(preview.id);await waitForChannelDiscoveryIdle()
  const unavailable=await store.get(preview.id);assert.equal(unavailable.discoveredVideos.length,1);assert.equal(unavailable.discovery.status,'blocked');assert.equal(unavailable.catalogComplete,false)
})

test('an interrupted discovery restores a resumable checkpoint rather than a completed catalog',async t=>{
  const {root,store}=await fixture(t)
  await store.list()
  const document=JSON.parse(await readFile(join(root,'channels.json'),'utf8'))
  Object.assign(document.channels[0],{discoveredVideos:[video('SAVED')],discovery:{status:'running',pagesFetched:3,nextCursor:'saved-page',hasNextPage:true,source:'instagram_authorized'}})
  await writeFile(join(root,'channels.json'),JSON.stringify(document))
  const calls=[],fresh=createChannelStore({root,discoverPage:async({cursor})=>{calls.push(cursor);return fullPage([video('AFTER_RESTART')],false)}})
  const interrupted=await fresh.get('instagram-dreamcode_films')
  assert.equal(interrupted.discovery.status,'partial');assert.equal(interrupted.discovery.resumable,true);assert.match(interrupted.discovery.message,/interrupted/)
  await fresh.startDiscovery(interrupted.id);await waitForChannelDiscoveryIdle()
  assert.deepEqual(calls,['saved-page']);assert.equal((await fresh.get(interrupted.id)).discovery.status,'complete')
})

test('catalog resource bounds report incomplete coverage instead of silently truncating at 100',async t=>{
  const {store}=await fixture(t,{discoverPage:async()=>fullPage(Array.from({length:CHANNEL_DISCOVERY_LIMITS.maxCatalogVideos+1},(_,i)=>video(`L${i}`)),false)})
  await store.startDiscovery('instagram-dreamcode_films');await waitForChannelDiscoveryIdle()
  const bounded=await store.get('instagram-dreamcode_films')
  assert.equal(bounded.discoveredVideos.length,10000);assert.equal(bounded.discovery.status,'partial');assert.equal(bounded.catalogComplete,false);assert.match(bounded.discovery.message,/limit.*10,000|10,000.*limit/)
})

test('repeated cursors stop discovery and preserve the last successful checkpoint',async t=>{
  const {store}=await fixture(t,{discoverPage:async({cursor})=>fullPage([video(cursor?'SECOND':'FIRST')],true,'repeated')})
  await store.startDiscovery('instagram-dreamcode_films');await waitForChannelDiscoveryIdle()
  const result=await store.get('instagram-dreamcode_films')
  assert.equal(result.discovery.status,'partial');assert.equal(result.catalogComplete,false);assert.equal(result.discovery.resumable,true);assert.match(result.discovery.message,/repeated a page cursor/);assert.equal(result.discoveredVideos.length,1)
})
