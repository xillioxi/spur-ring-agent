import {mkdir, readFile, writeFile, rename, unlink, realpath, stat, lstat, readdir, rm, open} from 'node:fs/promises'
import {resolve, join, extname, relative, isAbsolute, basename} from 'node:path'
import {randomUUID} from 'node:crypto'
import {createChannelStore,knownSourceChannel,sourceChannelId,channelObservations,waitForChannelDiscoveryIdle,CHANNEL_DISCOVERY_LIMITS} from './channels.mjs'
import {fetchChannelImage} from './channel-metadata.mjs'
import {createChannelImportManager} from './channel-imports.mjs'
import {createChannelAnalysisManager} from './channel-analyses.mjs'
import {replaceIndex} from './atomic-index.mjs'
import {buildAudioTimeline,annotateAudioShots} from './audio-timeline.mjs'
import {buildInversePrompt} from './engine.mjs'
import {analysisModels,defaultAnalysisModelId,resolveAnalysisSelection,analysisMatchesSelection,analysisHasCloudComponents} from './analysis-providers.mjs'
import {createReconstructionService} from './reconstruction.mjs'
import {resolveScriptTemplateId,scriptTemplateConfiguration,SCRIPT_TEMPLATE_REVISION,attachScriptBreakdown,scriptBreakdownText} from './script-templates.mjs'
import {analysisWorkflowConfiguration,resolveAnalysisWorkflow} from './analysis-workflows.mjs'
import {createReaFrameGrid} from './rea-frame-grid.mjs'
import {createFaceReferenceStore} from './face-references.mjs'

export const VIDEO_ANALYSIS_LIMITS = Object.freeze({maxUploadBytes:150*1024*1024,maxWorkspaceBytes:2*1024*1024*1024,maxDurationSeconds:300,maxItems:200,maxQueuedJobs:24})
export const REFERENCE_CHANNELS = Object.freeze([
  {id:'dreamcode_films',name:'dreamcode_films',url:'https://www.instagram.com/dreamcode_films/',referenceVideoUrl:'https://www.instagram.com/reel/DepDMxUAQPe/',referenceVideoTitle:'The Year 3267'},
  {id:'gdarusa',name:'gdarusa',url:'https://www.instagram.com/gdarusa/',referenceVideoUrl:'https://www.instagram.com/p/Dc-i1SJERpW/',referenceVideoTitle:'Feeling at home in Bangkok'},
])
const allowedExtensions = new Set(['.mp4','.mov','.webm','.mkv','.m4v','.avi'])
const itemId = /^[a-f0-9-]{36}$/
const maxResultBytes = 8*1024*1024
const services = new Map()
const queue = []
let active = false
let queueReservations = 0
const idleWaiters = new Set()
export class VideoAnalysisError extends Error {
  constructor(message,status=422,code='invalid_request') { super(message); this.name='VideoAnalysisError'; this.status=status; this.code=code }
}
const fail = (message,status=422,code) => new VideoAnalysisError(message,status,code)
const inside = (root,path) => { const part=relative(root,path); return !part.startsWith('..') && !isAbsolute(part) }
const clone = value => JSON.parse(JSON.stringify(value))
const now = () => new Date().toISOString()
const scalarText = (value,max=10000) => typeof value==='string'?value.slice(0,max):''
function selectAnalysis(config,{analysisModelId,analysisWorkflowId}={}) {
  const workflow=resolveAnalysisWorkflow(config,analysisWorkflowId)
  if(workflow.workflowId==='standard')return Object.freeze({...resolveAnalysisSelection(config,analysisModelId),...workflow})
  if(analysisModelId!==undefined&&!analysisModels(config).some(model=>model.id===analysisModelId))throw fail('Choose an available analysis model from the list.',422,'invalid_analysis_model')
  // The local workflow receives only its tools and media settings, never cloud credentials.
  const snapshot=Object.freeze(Object.fromEntries(Object.entries(config).filter(([key])=>/^SPUR_REA_VIDEO_|^SPUR_FFMPEG_|^SPUR_FFPROBE_/.test(key)||['FFMPEG_PATH','FFPROBE_PATH','SPUR_VIDEO_ANALYSIS_TEMP_ROOT'].includes(key))))
  return Object.freeze({id:null,provider:'rea-video',model:null,config:snapshot,target:null,...workflow})
}
function requireId(id) { if(typeof id!=='string'||!itemId.test(id)) throw fail('Video not found.',404,'not_found'); return id }
function safeFilename(filename) {
  if(typeof filename!=='string'||filename.length>240||filename.includes('\0')||/[\\/]/.test(filename)) throw fail('Provide a video filename.')
  const extension=extname(filename).toLowerCase()
  if(!allowedExtensions.has(extension)) throw fail('Use an MP4, MOV, WebM, MKV, M4V or AVI video.',415,'unsupported_media')
  return {filename,extension,title:filename.slice(0,-extension.length)||'Untitled video'}
}
function publicItem(item,{includeResult=true}={}) {
  const {mediaFile,pendingAction,reaReviewNotes,...value}=item
  if(!includeResult) delete value.result
  const output=clone({...value,hasMedia:!!mediaFile,hasResult:!!item.result})
  // Image bytes stay in private storage. Clients receive only fixed asset IDs.
  if(Array.isArray(output.result?.reaVideo?.assets))output.result.reaVideo.assets=output.result.reaVideo.assets.map(({dataBase64,...asset})=>({...asset,bytes:typeof dataBase64==='string'?Buffer.byteLength(dataBase64,'base64'):0}))
  return output
}
function mergeAnalysis(previous,incoming,mode,timestamp) {
  const value=clone(incoming)
  const workflowId=value.analysisWorkflowId||'standard'
  const priorWorkflowId=previous?.result?.analysisWorkflowId||previous?.result?.provenance?.workflow?.id||(previous?.result?.reaVideo?'rea-video':'standard')
  // Components from different workflows cannot be treated as one analysis.
  const old=workflowId===priorWorkflowId?previous?.result:undefined
  if(workflowId!=='rea-video')delete value.reaVideo
  value.provenance||={}
  // OCR and visual composition can come from different analysis runs. Keep the
  // fresh text evidence independent of any retained visual reconstruction plan.
  if(!value.provenance.ocr&&value.provenance.vision) value.provenance.ocr={...clone(value.provenance.vision),purpose:'on_screen_text'}
  const componentKeys=['boundaries','speech','vision','ocr','audio','soundEvents','multimodal']
  const priorComponents=old?.provenance?.components||Object.fromEntries(componentKeys.filter(key=>old?.provenance?.[key]).map(key=>[key,{analyzedAt:previous.updatedAt,mode:old.mode||'both',detail:old.provenance[key]}]))
  const components={...priorComponents}
  for(const key of componentKeys) if(value.provenance[key]) components[key]={analyzedAt:timestamp,mode,detail:clone(value.provenance[key])}
  if(old&&mode==='script') {
    value.shots=clone(old.shots||value.shots)
    value.inversePrompt=old.inversePrompt??value.inversePrompt
    const observations=value.script.onScreenText
    for(const shot of value.shots) {
      // Timed OCR samples remain points. An observation with several explicit
      // sample times can contribute to each interval where it was seen.
      const inInterval=time=>Number.isFinite(time)&&time>=shot.startSeconds&&time<shot.endSeconds
      if(Array.isArray(observations)) {
        shot.onScreenText=[...new Set(observations.filter(observation=>{
          if(Array.isArray(observation.observedAtSeconds)&&observation.observedAtSeconds.length) return observation.observedAtSeconds.some(inInterval)
          if(observation.endSeconds>observation.startSeconds) return observation.startSeconds<shot.endSeconds&&observation.endSeconds>shot.startSeconds
          return inInterval(observation.startSeconds)
        }).map(observation=>observation.text))]
      } else {
        shot.onScreenText=[...new Set((incoming.shots||[]).filter(fresh=>fresh.startSeconds<shot.endSeconds&&fresh.endSeconds>shot.startSeconds).flatMap(fresh=>fresh.onScreenText||[]))]
      }
    }
    for(const key of ['vision','boundaries']) {
      if(old.provenance?.[key]) value.provenance[key]=clone(old.provenance[key])
      if(priorComponents[key]) components[key]=clone(priorComponents[key]); else delete components[key]
    }
    if(['vision','boundaries'].some(key=>['failed','partial','unavailable'].includes(old.provenance?.[key]?.status)))value.status='partial'
  }
  if(old&&mode==='breakdown') {
    value.script.segments=clone(old.script?.segments||[])
    if(Array.isArray(old.script?.words)) value.script.words=clone(old.script.words)
    else delete value.script.words
    value.script.text=old.script?.text||''
    value.language=old.language??value.language
    if(old.provenance?.speech) value.provenance.speech=clone(old.provenance.speech)
    if(priorComponents.speech) components.speech=clone(priorComponents.speech);else delete components.speech
  }
  if(old&&mode==='audio') {
    value.shots=clone(old.shots||value.shots)
    value.script.onScreenText=clone(old.script?.onScreenText||[])
    for(const key of ['vision','boundaries','ocr']) {
      if(old.provenance?.[key])value.provenance[key]=clone(old.provenance[key])
      if(priorComponents[key])components[key]=clone(priorComponents[key]);else delete components[key]
    }
    // Retain incomplete visuals, but let a successful audio retry repair an
    // audio-only failure when the retained frames and OCR were fully processed.
    const retainedIncomplete=['vision','ocr'].some(key=>{
      const detail=old.provenance?.[key]
      return detail&&(['partial','failed','unavailable'].includes(detail.status)||detail.status==='analyzed'&&Number.isFinite(detail.sampledFrameCount)&&detail.sampledFrameCount<value.shots.length*2)
    })
    const unknownPartial=(old.status==='partial'||previous.status==='partial')&&!old.provenance?.vision&&!old.provenance?.ocr
    if(retainedIncomplete||unknownPartial)value.status='partial'
  }
  // Word midpoints assign a word crossing a cut to exactly one shot. Never
  // replace an engine's aligned text with an entire overlapping sentence.
  const joinWords=words=>words.map(word=>word.text).join(' ').replace(/\s+([,.;:!?。！？、，])/g,'$1').replace(/([\u3000-\u9fff])\s+(?=[\u3000-\u9fff])/g,'$1')
  if(Array.isArray(value.script.words)&&value.script.words.length) {
    for(const shot of value.shots) shot.spokenText=joinWords(value.script.words.filter(word=>{
      const midpoint=(word.startSeconds+word.endSeconds)/2
      return midpoint>=shot.startSeconds&&midpoint<shot.endSeconds
    }))
  } else if(old&&mode!=='both') {
    // Legacy analyses may have only sentence timestamps; use one midpoint
    // assignment rather than duplicating the sentence on every cut it spans.
    for(const shot of value.shots) shot.spokenText=joinWords(value.script.segments.filter(segment=>{
      const midpoint=(segment.startSeconds+segment.endSeconds)/2
      return midpoint>=shot.startSeconds&&midpoint<shot.endSeconds
    }))
  }
  value.provenance.components=components
  if(value.audio?.timelineVersion===1) {
    const evidence=value.audio
    value.audio={...evidence,...buildAudioTimeline({durationSeconds:value.metadata?.durationSeconds||value.durationSeconds||previous.durationSeconds,shots:value.shots,script:value.script,measurementAudio:{status:evidence.status,windows:evidence.windows,onsetCandidates:evidence.onsetCandidates,limitations:evidence.limitations},hasAudio:value.metadata?.hasAudio,speechStatus:value.provenance.speech?.status,semanticEvents:evidence.semanticEvents,semanticStatus:evidence.semanticStatus,semanticSegments:evidence.semanticSegments,semanticDescription:evidence.semanticDescription})}
    value.shots=annotateAudioShots(value.shots,value.audio)
    for(const shot of value.shots)shot.reconstructionPrompt=buildInversePrompt([shot])
    value.inversePrompt=buildInversePrompt(value.shots)
  }
  if(old&&mode!=='both') {
    const refreshedCloudVisuals=mode==='breakdown'&&['siliconflow','poe'].includes(value.provenance.multimodal?.provider)&&value.shots.length>0&&['analyzed','partial'].includes(value.provenance.vision?.status)&&!value.provenance.vision?.failures?.length
    // A successful visual retry replaces the failed visual pass. Do not keep
    // presenting its old failure as a current problem after recovery.
    const retainedWarnings=refreshedCloudVisuals?[]:old.warnings||[]
    value.warnings=[...new Set([...value.warnings,...retainedWarnings.map(warning=>warning.startsWith('Retained analysis: ')?warning:`Retained analysis: ${warning}`)])].slice(0,200)
    if(refreshedCloudVisuals&&value.script.text)value.warnings.push('Spoken words were retained from the previous analysis. Verify the transcript against the original audio.')
    if(refreshedCloudVisuals&&['failed','partial','unavailable'].includes(value.provenance.speech?.status)) {
      value.status='partial'
      value.warnings.push('The previous speech analysis is incomplete. Run Video + audio to refresh it.')
    }
    if(!value.provenance.multimodal)value.summary=`${value.metadata?.durationSeconds||value.durationSeconds||previous.durationSeconds||''} seconds; ${value.shots.length} shot interval(s), ${value.script.segments.length} speech segment(s) and ${(value.script.onScreenText||[]).length} on-screen text observation(s).${value.audio?.timelineVersion===1?` ${(value.audio.semanticEvents||[]).length} sound-event interval(s) aligned with the shots.`:''}`
  }
  if(workflowId==='rea-video') {
    const retainedReview=previous?.reaReviewNotes||old?.reaVideo?.reviewNotes
    if(retainedReview&&!value.reaVideo.reviewNotes)value.reaVideo.reviewNotes=clone(retainedReview)
    value.inversePrompt=null
    for(const shot of value.shots)shot.reconstructionPrompt=null
  }
  return value
}
function safeUrl(raw) {
  if(typeof raw!=='string'||raw.length>4096) throw fail('Provide a video URL.')
  let url
  try { url=new URL(raw) } catch { throw fail('Provide a valid video URL.') }
  if(url.protocol!=='https:'||url.username||url.password||url.port&&url.port!=='443'||/^(localhost|.*\.localhost|.*\.local)$/i.test(url.hostname)) throw fail('Use a public HTTPS video URL.')
  return url.href
}
async function directoryBytes(directory) {
  let size=0
  for(const entry of await readdir(directory,{withFileTypes:true})) {
    const path=join(directory,entry.name)
    if(entry.isSymbolicLink()) throw fail('Video storage contains an unsupported symbolic link.',503,'storage_unavailable')
    if(entry.isDirectory()) size+=await directoryBytes(path)
    else if(entry.isFile()) size+=(await stat(path)).size
  }
  return size
}
function reserveQueue() {
  if(queue.length+queueReservations>=VIDEO_ANALYSIS_LIMITS.maxQueuedJobs) throw fail('The video queue is full. Try again after another video finishes.',429,'queue_full')
  queueReservations++
  let held=true
  return {
    release() {if(held){held=false;queueReservations--}},
    enqueue(work) {if(!held)throw Error('Queue reservation has already been released.');held=false;queueReservations--;queue.push(work);setImmediate(drain)},
  }
}
async function drain() {
  if(active) return
  active=true
  try { while(queue.length) { try { await queue.shift()() } catch { /* A job persists its own failure. */ } } }
  finally { active=false; for(const done of idleWaiters) done(); idleWaiters.clear() }
}
export function waitForVideoAnalysisIdle() {
  if(!active&&!queue.length&&!queueReservations) return waitForChannelDiscoveryIdle()
  return new Promise(done=>idleWaiters.add(done)).then(waitForChannelDiscoveryIdle)
}

export function createReelTextExport(item,format='txt') {
  if(!['txt','md','json'].includes(format)) throw fail('Choose TXT, Markdown or JSON.')
  const value=publicItem(item)
  if(format==='json') return {body:JSON.stringify(value,null,2)+'\n',contentType:'application/json; charset=utf-8',extension:'json'}
  const result=item.result
  if(!result) throw fail('Analyze this video before exporting text.',409,'analysis_required')
  const clock=seconds=>{ const number=Math.max(0,Number(seconds)||0); return `${Math.floor(number/60).toString().padStart(2,'0')}:${(number%60).toFixed(2).padStart(5,'0')}` }
  const lines=[]
  const heading=(text,level=1)=>lines.push(format==='md'?`${'#'.repeat(level)} ${text}`:text,'')
  heading(item.title||'Video analysis')
  const latest=result.provenance?.multimodal
  const sources=[['Visual analysis','vision'],['Speech transcription','speech'],['Sound analysis','soundEvents']].flatMap(([label,key])=>{
    const detail=result.provenance?.[key]
    if(!detail||detail.status&&!['analyzed','partial'].includes(detail.status))return []
    const localMethod=['whisper.cpp','yamnet_waveform_classification'].includes(detail.method)
    if(!detail.provider&&!detail.model&&!localMethod)return []
    const provider=detail.provider||(localMethod?'local':'unspecified')
    const model=detail.model||(detail.provider&&detail.provider===latest?.provider?latest.model:null)||'unspecified'
    return [{label,provider,model}]
  })
  if(new Set(sources.map(source=>JSON.stringify([source.provider,source.model]))).size>1){
    lines.push('Analysis sources: mixed (components use different providers or models).','')
    for(const source of sources)lines.push(`${source.label}: ${source.provider}; model: ${source.model}`)
    lines.push('')
  }else if(latest?.provider)lines.push(`Analysis provider: ${latest.provider}; model: ${latest.model || 'unspecified'}${latest.visionModel?`; visual model: ${latest.visionModel}`:''}`,'')
  if(item.source?.url) lines.push(`Source: ${item.source.url}`,'')
  if(item.source?.profileUrl) lines.push(`Source profile: ${item.source.profileUrl}`,'')
  if(item.source?.discoveryMethod==='public_profile_embed') lines.push('Source discovery: Instagram public channel preview (one reference video, not a complete channel archive).','')
  if(result.summary) lines.push(result.summary,'')
  if(result.reaVideo) {
    heading('Rea Video local technical analysis',2)
    lines.push(`Review: ${result.reaVideo.reviewStatus || 'unreviewed'}; visual-language review: ${result.reaVideo.vlmStatus || 'not_requested'}.`)
    if(result.reaVideo.verdict)lines.push(`Technical verdict: ${result.reaVideo.verdict}`)
    for(const shot of result.reaVideo.technicalShots||[]) {
      lines.push(`[${clock(shot.startSeconds)}–${clock(shot.endSeconds)}] ${shot.label || 'Technical shot observation'}${Number.isFinite(shot.confidence)?` (confidence: ${shot.confidence})`:''}`)
      for(const evidence of shot.evidence||[])if(typeof evidence==='string')lines.push(`Evidence: ${evidence}`)
    }
    for(const limitation of result.reaVideo.limitations||[])lines.push(`Limitation: ${limitation}`)
    for(const section of result.reaVideo.sections||[]) {
      heading(`${section.title} · unreviewed local estimates`,3)
      lines.push(section.body,'')
    }
    for(const candidate of result.reaVideo.soundCandidates||[])lines.push(`Possible sound event [${clock(candidate.startSeconds)}–${clock(candidate.endSeconds)}]: ${candidate.description} (signal candidate; not confirmed by listening)`)
    for(const feature of result.reaVideo.capabilities||[])lines.push(`Feature: ${feature.label} — ${feature.status}: ${feature.detail}`)
    const notes=result.reaVideo.reviewNotes
    if(notes) {
      heading('User review notes · supplied manually, not model findings',3)
      lines.push(`Saved: ${notes.updatedAt}`)
      for(const key of ['summary','hook','payoff','characters','corrections'])if(notes[key])lines.push(`${key}: ${notes[key]}`)
    }
    if(result.reaVideo.assets?.length)lines.push(`Visual exports: ${result.reaVideo.assets.map(asset=>asset.label).join('; ')} (download from the video breakdown).`)
    lines.push('')
  }
  lines.push(...scriptBreakdownText(result,{clock,format}))
  heading('Spoken script',2)
  if(result.script?.segments?.length) for(const segment of result.script.segments) lines.push(`[${clock(segment.startSeconds)}–${clock(segment.endSeconds)}] ${segment.text}`)
  else lines.push(result.script?.text||'No spoken script was recovered.')
  lines.push(''); heading('On-screen text',2)
  const screens=result.script?.onScreenText||[]
  if(screens.length) for(const segment of screens) lines.push(`[${clock(segment.startSeconds)}–${clock(segment.endSeconds)}] ${segment.text}`)
  else lines.push('No on-screen text was recovered.')
  if(result.audio?.segments?.length){
    lines.push('');heading('Synchronized audio timeline',2)
    if(result.audio.description)lines.push(result.audio.description)
    if(result.audio.semanticModel)lines.push(`Sound-event model: ${result.audio.semanticModel}; labels are estimates from the soundtrack.`)
    for(const segment of result.audio.segments){
      lines.push(`[${clock(segment.startSeconds)}–${clock(segment.endSeconds)}] ${segment.description||segment.status}`)
      if(segment.spokenText)lines.push(`Spoken words: ${segment.spokenText}`)
      for(const event of segment.events||[])lines.push(`Detected sound: ${event.label} (${clock(event.startSeconds)}–${clock(event.endSeconds)}${Number.isFinite(event.confidence)?`; model score ${event.confidence}`:''})${event.description?`: ${event.description}`:''}`)
    }
  }
  lines.push(''); heading('Shot breakdown / inverse prompts',2)
  if(result.inversePrompt) {lines.push(result.inversePrompt,'')}
  for(const shot of result.shots||[]) {
    heading(`Shot ${shot.index+1} · ${clock(shot.startSeconds)}–${clock(shot.endSeconds)}`,3)
    for(const [label,key] of [['Visual','visual'],['Framing','framing'],['Camera movement','cameraMovement'],['Action','action'],['Audio','audio'],['Spoken words','spokenText']]) if(shot[key]) lines.push(`${label}: ${shot[key]}`)
    if(shot.reconstructionPrompt) lines.push(`Reconstruction prompt: ${shot.reconstructionPrompt}`)
    if(shot.onScreenText?.length) lines.push(`On-screen text: ${shot.onScreenText.join(' | ')}`)
    lines.push('')
  }
  if(result.warnings?.length) { heading('Analysis notes',2); for(const warning of result.warnings) lines.push(`- ${warning}`); lines.push('') }
  return {body:lines.join('\n')+'\n',contentType:format==='md'?'text/markdown; charset=utf-8':'text/plain; charset=utf-8',extension:format}
}

export function createVideoAnalysisService({root,engine,importer,config={},getDiscoveryConfig}) {
  if(typeof root!=='string'||!root.trim()||root.includes('\0')) throw fail('Video storage is not configured.',503,'storage_unavailable')
  const storageRoot=resolve(root)
  const cached=services.get(storageRoot)
  if(cached) { cached.configure({engine,importer,config,getDiscoveryConfig}); return cached }
  const mediaRoot=join(storageRoot,'media'),importsRoot=join(storageRoot,'imports'),indexPath=join(storageRoot,'reference-library.json')
  let items=[],loaded=false,serial=Promise.resolve(),inflightUploadBytes=0,currentEngine=engine,currentImporter=importer,currentConfig=config,currentGetDiscoveryConfig=getDiscoveryConfig,reconstructions,framesRunning=false
  const faceReferences=createFaceReferenceStore({root:storageRoot,getConfig:()=>currentConfig})
  const faceReferenceCall=async work=>{
    try{return await work()}catch(error){
      if(error instanceof VideoAnalysisError)throw error
      const known=/^(face_reference_|facecap_|analysis_cancelled)/.test(error?.code||'')
      throw fail(known?error.message:'Face references could not be processed. Check the local image tools and storage.',known?error.status||422:503,known?error.code:'face_reference_failed')
    }
  }
  const reconstructionCall=async work=>{try{return await work()}catch(error){if(error instanceof VideoAnalysisError)throw error;throw fail(error?.code?.startsWith('reconstruction_')?error.message:'The recreation operation could not complete.',error?.status||500,error?.code?.startsWith('reconstruction_')?error.code:'reconstruction_failed')}}
  const discoverPage=async args=>{
    if(!currentImporter?.discoverChannelPage)return {requiresConnection:true,message:'Full channel discovery needs a paginated Instagram connection. The public preview cannot verify the complete feed.'}
    const discoveryConfig={...currentConfig,...await currentGetDiscoveryConfig?.()}
    try{return await currentImporter.discoverChannelPage({...args,config:discoveryConfig})}
    catch(error){
      // A provider request URL may include its access token. Never persist it in
      // a public progress/error field, even when the provider throws verbatim.
      let message=typeof error?.message==='string'?error.message:'Channel discovery could not finish.'
      for(const [key,value]of Object.entries(discoveryConfig))if(/TOKEN|SECRET|PASSWORD|KEY/i.test(key)&&typeof value==='string'&&value.length>3)message=message.split(value).join('[redacted]')
      const safe=fail(message,error?.status,error?.code);safe.requiresConnection=!!error?.requiresConnection;throw safe
    }
  }
  const channels=createChannelStore({root:storageRoot,createError:fail,discover:args=>currentImporter?.discoverChannel?currentImporter.discoverChannel({...args,config:currentConfig}):Promise.reject(fail('Public channel refresh is unavailable. You can still add individual videos.',503)),discoverPage,fetchImage:fetchChannelImage})
  const importedProfileSyncs=new Set()
  const bulkImports=createChannelImportManager({root:storageRoot,getChannel:id=>channels.get(id),importOne:async(url,channelId)=>{
    const receipt=await service.importUrl(url,{channelId}),skipped=receipt.hasMedia===true
    if(['queued','importing','analyzing'].includes(receipt.status))await waitForVideoAnalysisIdle()
    const item=await service.get(receipt.id)
    if([429,503,507].includes(item.importErrorStatus))throw fail(item.error||'Channel import is temporarily unavailable.',item.importErrorStatus)
    return {...item,skipped}
  }})
  const bulkAnalyses=createChannelAnalysisManager({root:storageRoot,getItems:id=>service.list({channelId:id}),analyzeOne:async(id,channelId,selection)=>{
    let item=await service.get(id)
    if(sourceChannelId(item.source)!==channelId)throw fail('This video is no longer in this channel.',409)
    if(['queued','importing','analyzing'].includes(item.status)){await waitForVideoAnalysisIdle();item=await service.get(id)}
    if(analysisMatchesSelection(item,selection))return {...item,skipped:true}
    // The complete batch uses the server configuration captured at its start.
    await queueAnalysis(id,{mode:selection.workflowId!=='rea-video'&&selection.provider==='local'&&item.hasResult&&!item.result?.reaVideo&&!item.result?.provenance?.multimodal&&!analysisHasCloudComponents(item)?'audio':'both'},selection);await waitForVideoAnalysisIdle()
    item=await service.get(id)
    if([429,503,507].includes(item.analysisErrorStatus))throw fail(item.error||'Channel analysis is temporarily unavailable.',item.analysisErrorStatus)
    return item
  }})
  let batchSerial=Promise.resolve()
  const batchExclusive=work=>{const value=batchSerial.then(work,work);batchSerial=value.catch(()=>{});return value}
  const batchRunning=job=>job&&['running','stopping'].includes(job.status)
  async function channelWithImports(channel,values){
    const [bulkImport,bulkAnalysis]=await Promise.all([bulkImports.get(channel.id),bulkAnalyses.get(channel.id)])
    return {...channel,observations:channelObservations(values,channel.id),bulkImport,bulkAnalysis,updatedAt:[channel.updatedAt,bulkImport?.updatedAt,bulkAnalysis?.updatedAt].filter(Boolean).sort().at(-1)}
  }
  const exclusive=work=>{ const result=serial.then(work,work); serial=result.catch(()=>{}); return result }
  async function checkedIndex() {
    try {
      const info=await lstat(indexPath)
      if(info.isSymbolicLink()||!info.isFile()||!inside(await realpath(storageRoot),await realpath(indexPath))) throw fail('The video reference index must be a regular file inside its workspace.',503,'storage_unavailable')
      return info
    } catch(error) { if(error.code==='ENOENT') return null;throw error }
  }
  async function persist() {
    const data=JSON.stringify({schemaVersion:1,items})
    if(Buffer.byteLength(data)>32*1024*1024) throw fail('The reference library is full. Export existing analyses before adding more videos.',507,'storage_full')
    const previous=await checkedIndex()
    if(await directoryBytes(storageRoot)-(previous?.size||0)+Buffer.byteLength(data)>VIDEO_ANALYSIS_LIMITS.maxWorkspaceBytes) throw fail('The video workspace has reached its 2 GiB limit.',507,'storage_full')
    const temp=join(storageRoot,`.reference-library-${randomUUID()}.tmp`)
    try { await writeFile(temp,data,{flag:'wx',mode:0o600}); await replaceIndex(temp,indexPath) }
    finally { await unlink(temp).catch(()=>{}) }
  }
  async function load() {
    if(loaded) return
    await mkdir(mediaRoot,{recursive:true}); await mkdir(importsRoot,{recursive:true})
    if(!inside(await realpath(storageRoot),await realpath(mediaRoot))||!inside(await realpath(storageRoot),await realpath(importsRoot))) throw fail('Video storage must stay inside its workspace.',503,'storage_unavailable')
    let recovered=false
    try {
      await checkedIndex()
      const text=await readFile(indexPath,'utf8')
      if(Buffer.byteLength(text)>32*1024*1024) throw Error('oversized')
      const document=JSON.parse(text)
      if(document.schemaVersion!==1||!Array.isArray(document.items)||document.items.length>VIDEO_ANALYSIS_LIMITS.maxItems) throw Error('invalid')
      const seen=new Set()
      items=document.items.map(item=>{
        if(!item||!itemId.test(item.id)||seen.has(item.id)||item.mediaFile&&(basename(item.mediaFile)!==item.mediaFile||!allowedExtensions.has(extname(item.mediaFile)))) throw Error('invalid')
        seen.add(item.id)
        if(['queued','importing','analyzing'].includes(item.status)) { item.status='failed'; item.error='Processing was interrupted by a restart. Retry the import or analysis.'; item.retryable=true; item.progress='Interrupted'; item.updatedAt=now(); delete item.pendingAction; recovered=true }
        return item
      })
    } catch(error) { if(error.code!=='ENOENT') throw fail('The video reference library could not be read. Existing files were preserved.',503,'storage_unavailable') }
    // Old imports already retained profile provenance. Group them by that owner,
    // without guessing from titles or whichever channel happens to be selected.
    for(const item of items) {
      const owner=knownSourceChannel(item.source)
      if(owner){await channels.ensure(owner.url);if(item.source.channelId!==owner.id){item.source.channelId=owner.id;recovered=true}}
    }
    loaded=true
    if(recovered) await persist()
  }
  const initialize=()=>exclusive(load)
  function find(id) { requireId(id); const item=items.find(value=>value.id===id); if(!item) throw fail('Video not found.',404,'not_found'); return item }
  async function patch(id,fields) { return exclusive(async()=>{ await load(); const item=find(id),previous=clone(item); Object.assign(item,fields,{updatedAt:now()}); try{await persist()}catch(error){items[items.indexOf(item)]=previous;throw error} return publicItem(item) }) }
  function errorText(error) {
    let message=scalarText(error?.message,1000)||'This video could not be processed. Try another video or upload its file.'
    for(const path of [storageRoot,mediaRoot,importsRoot]) message=message.split(path).join('[workspace]')
    return message.replace(/Bearer\s+\S+/gi,'Bearer [redacted]').replace(/(?:sk-|sk_)[A-Za-z0-9_-]{12,}/g,'[redacted]')
  }
  async function checkedMedia(item) {
    if(!item.mediaFile||basename(item.mediaFile)!==item.mediaFile) throw fail('This video has no local media. Import or upload it first.',409,'media_required')
    const path=join(mediaRoot,item.mediaFile)
    let actual,info
    try { actual=await realpath(path); info=await stat(actual) } catch { throw fail('The video file is missing. Upload or import it again.',404,'media_missing') }
    if(!inside(await realpath(mediaRoot),actual)||!info.isFile()) throw fail('Video media is outside its workspace.',403,'invalid_media')
    return {filePath:actual,size:info.size,filename:item.source?.filename||`${item.id}${extname(actual)}`,extension:extname(actual).toLowerCase()}
  }
  async function analysisJob(id,mode,selection,jobEngine) {
    try {
      const item=await exclusive(async()=>{await load(); return clone(find(id))}),media=await checkedMedia(item)
      if(!jobEngine?.analyze) throw fail('Video analysis is not configured on this server.',503,'analysis_unavailable')
      await patch(id,{status:'analyzing',progress:'Reading video and audio…',error:undefined,retryable:false})
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15*60*1000)
      let result
      try { result=await jobEngine.analyze({filePath:media.filePath,allowedRoots:[mediaRoot],mode,scriptTemplateId:selection.scriptTemplateId,analysisWorkflowId:selection.workflowId,config:selection.config,signal:controller.signal,onProgress:message=>patch(id,{progress:scalarText(typeof message==='string'?message:message?.message,240)}).catch(()=>{})}) }
      finally { clearTimeout(timer) }
      if(!result||result.schemaVersion!==1||!Array.isArray(result.shots)||!result.script||!Array.isArray(result.script.segments)||!Array.isArray(result.warnings)||Buffer.byteLength(JSON.stringify(result))>maxResultBytes) throw fail('The analyzer returned an incomplete or oversized result.',502,'invalid_analysis')
      if(selection.workflowId==='rea-video'&&(result.reaVideo?.schemaVersion!==1||result.reaVideo?.workflowRevision!==selection.workflowRevision||!Array.isArray(result.reaVideo?.technicalShots)))throw fail('Rea Video returned an incomplete technical report.',502,'invalid_analysis')
      result.analysisWorkflowId=selection.workflowId
      result.provenance||={}
      result.provenance.workflow={...(result.provenance.workflow||{}),id:selection.workflowId,revision:selection.workflowRevision}
      // Provider output is data; private process paths and credentials never belong in a public analysis.
      const clean=mergeAnalysis(item,result,mode,now())
      attachScriptBreakdown(clean,{templateId:selection.scriptTemplateId,mode})
      delete clean.filePath; delete clean.allowedRoots; delete clean.config
      if(clean.provenance) for(const field of ['filePath','path','directory','apiKey','token','secret','authorization']) delete clean.provenance[field]
      const duration=Number(result.durationSeconds??result.metadata?.durationSeconds??Math.max(0,...result.shots.map(shot=>Number(shot.endSeconds)||0)))
      if(duration>VIDEO_ANALYSIS_LIMITS.maxDurationSeconds+0.1) throw fail('Use a video of five minutes or less.',422,'duration_limit')
      if(Buffer.byteLength(JSON.stringify(clean))>maxResultBytes)throw fail('The script production breakdown exceeds the saved analysis size limit.',502,'invalid_analysis')
      await patch(id,{status:clean.status==='partial'||clean.partial===true?'partial':'complete',progress:'Analysis ready',result:clean,durationSeconds:Number.isFinite(duration)?duration:undefined,error:undefined,retryable:false,pendingAction:undefined})
    } catch(error) { await patch(id,{status:'failed',progress:'Analysis failed',error:errorText(error),analysisErrorStatus:error.status,retryable:true,pendingAction:undefined}).catch(()=>{}) }
  }
  async function queueAnalysis(id,{mode='both'}={},selection) {
    if(!['both','breakdown','script','audio'].includes(mode)) throw fail('Choose video and audio, shot breakdown, script or audio only.')
    if(selection.workflowId==='rea-video'&&!['both','breakdown'].includes(mode))throw fail('Rea Video supports video breakdown only. Choose the standard workflow for transcript or audio analysis.',422,'unsupported_analysis_workflow_mode')
    return exclusive(async()=>{
      await load();const item=find(id)
      if(['queued','importing','analyzing'].includes(item.status)) return publicItem(item)
      await checkedMedia(item)
      const jobEngine=currentEngine
      if(!jobEngine?.analyze) throw fail('Video analysis is not configured on this server.',503,'analysis_unavailable')
      const slot=reserveQueue(),previous=clone(item)
      Object.assign(item,{status:'queued',progress:'Waiting to analyze…',mode,analysisModelId:selection.id,analysisWorkflowId:selection.workflowId,analysisWorkflowRevision:selection.workflowRevision,scriptTemplateId:selection.scriptTemplateId,scriptTemplateRevision:selection.scriptTemplateRevision,pendingAction:'analyze',error:undefined,analysisErrorStatus:undefined,retryable:false,updatedAt:now()})
      try {await persist();slot.enqueue(()=>analysisJob(id,mode,selection,jobEngine))}catch(error){items[items.indexOf(item)]=previous;slot.release();throw error}
      return publicItem(item)
    })
  }
  async function importJob(id,url) {
    const directory=join(importsRoot,id)
    let reservedBytes=0
    try {
      if(!currentImporter?.importVideo) throw fail('Link importing is unavailable. Download the video you can access and upload its file.',503,'import_unavailable')
      await exclusive(async()=>{
        await load()
        if(await directoryBytes(storageRoot)+inflightUploadBytes+VIDEO_ANALYSIS_LIMITS.maxUploadBytes>VIDEO_ANALYSIS_LIMITS.maxWorkspaceBytes) throw fail('The video workspace needs room for another video within its 2 GiB limit.',507,'storage_full')
        reservedBytes=VIDEO_ANALYSIS_LIMITS.maxUploadBytes
        inflightUploadBytes+=reservedBytes
      })
      await mkdir(directory,{recursive:true})
      await patch(id,{status:'importing',progress:'Importing video…',error:undefined,retryable:false})
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5*60*1000)
      let result
      try { result=await currentImporter.importVideo({url,directory,config:currentConfig,maxBytes:VIDEO_ANALYSIS_LIMITS.maxUploadBytes,maxDurationSeconds:VIDEO_ANALYSIS_LIMITS.maxDurationSeconds,signal:controller.signal,onProgress:message=>patch(id,{progress:scalarText(typeof message==='string'?message:message?.message,240)}).catch(()=>{})}) }
      finally { clearTimeout(timer) }
      if(typeof result?.filePath!=='string') throw fail('The importer did not return a video file.',502,'import_failed')
      const actual=await realpath(result.filePath),safeRoot=await realpath(directory),info=await stat(actual)
      if(!inside(safeRoot,actual)||!info.isFile()||!allowedExtensions.has(extname(actual).toLowerCase())) throw fail('The importer returned an unsupported file.',502,'import_failed')
      if(!info.size||info.size>VIDEO_ANALYSIS_LIMITS.maxUploadBytes) throw fail('The video exceeds the 150 MiB file limit.',413,'upload_limit')
      if(result.durationSeconds!==undefined&&(!Number.isFinite(result.durationSeconds)||result.durationSeconds<=0||result.durationSeconds>VIDEO_ANALYSIS_LIMITS.maxDurationSeconds)) throw fail('Choose a recorded video of five minutes or less.',422,'duration_limit')
      if(await directoryBytes(storageRoot)+inflightUploadBytes-reservedBytes>VIDEO_ANALYSIS_LIMITS.maxWorkspaceBytes) throw fail('The video workspace has reached its 2 GiB limit.',507,'storage_full')
      const source={kind:'url',url:safeUrl(result.sourceUrl||url),requestedUrl:url}
      if(result.profileUrl) source.profileUrl=safeUrl(result.profileUrl)
      if(typeof result.creatorHandle==='string') source.creatorHandle=result.creatorHandle.slice(0,30)
      const requestedChannelId=(await exclusive(async()=>{await load();return find(id).source?.channelId}))
      const owner=knownSourceChannel(source)
      if(owner){
        const channel=await channels.ensure(owner.url);source.channelId=owner.id
        // Individual TikTok links can create a channel too. Fetch its public
        // artwork once, rather than repeating profile discovery for every clip.
        if(owner.platform==='tiktok'&&!channel.lastSyncedAt&&!importedProfileSyncs.has(owner.id)&&currentImporter?.discoverChannel){
          importedProfileSyncs.add(owner.id);await channels.sync(owner.id).catch(()=>{})
        }
      }
      else if(requestedChannelId) source.channelId=requestedChannelId
      if(result.discoveryMethod==='public_profile_embed') source.discoveryMethod=result.discoveryMethod
      const mediaFile=`${id}${extname(actual).toLowerCase()}`
      await rename(actual,join(mediaRoot,mediaFile))
      await patch(id,{title:scalarText(result.title,240)||'Imported video',source:{...source,filename:basename(mediaFile)},mediaFile,bytes:info.size,durationSeconds:result.durationSeconds,status:'ready',progress:'Video imported. Choose an analysis.',error:undefined,retryable:false,pendingAction:undefined})
    } catch(error) { await patch(id,{status:'failed',progress:'Import failed',error:errorText(error),importErrorStatus:error.status,retryable:true,pendingAction:undefined}).catch(()=>{}) }
    finally { await rm(directory,{recursive:true,force:true}).catch(()=>{});inflightUploadBytes-=reservedBytes }
  }
  const service={
    configure(next) { if(next.engine) currentEngine=next.engine; if(next.importer) currentImporter=next.importer; if(next.config) currentConfig=next.config;if(next.getDiscoveryConfig)currentGetDiscoveryConfig=next.getDiscoveryConfig },
    async status() { await initialize(); await reconstructions.list(); const capabilities=currentEngine?.capabilities?{...await currentEngine.capabilities(currentConfig)}:{analysis:false,notes:['Video analysis is not configured.']};if(currentImporter?.capabilities)capabilities.importer=await currentImporter.capabilities(currentConfig);capabilities.reconstruction=await reconstructions.capability();return {capabilities,...scriptTemplateConfiguration(),...analysisWorkflowConfiguration(currentConfig),analysisModels:analysisModels(currentConfig,{localCapability:defaultAnalysisModelId(currentConfig)==='local'?capabilities:undefined}),defaultAnalysisModelId:defaultAnalysisModelId(currentConfig),limits:{...VIDEO_ANALYSIS_LIMITS,channelDiscovery:{...CHANNEL_DISCOVERY_LIMITS}},referenceChannels:clone(REFERENCE_CHANNELS)} },
    async list({channelId}={}) {if(channelId!==undefined)await channels.get(channelId);return exclusive(async()=>{await load(); return items.filter(item=>channelId===undefined||sourceChannelId(item.source)===channelId).map(item=>publicItem(item,{includeResult:false})).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))}) },
    async get(id) { return exclusive(async()=>{await load(); return publicItem(find(id))}) },
    async listFaceReferences(channelId){await channels.get(channelId);return faceReferenceCall(()=>faceReferences.list(channelId))},
    async uploadFaceReference(channelId,stream,options){await channels.get(channelId);return faceReferenceCall(()=>faceReferences.upload(channelId,stream,options))},
    async captureFaceReferences(id){
      const item=await exclusive(async()=>{await load();return clone(find(id))})
      const channelId=sourceChannelId(item.source)
      if(!channelId)throw fail('Assign this video to a channel before collecting its face references.',409,'face_reference_channel_required')
      await channels.get(channelId)
      const durationSeconds=item.durationSeconds||item.result?.metadata?.durationSeconds
      if(!Number.isFinite(durationSeconds)||durationSeconds<=0||durationSeconds>300)throw fail('Import or analyze this saved video to establish its duration before extracting references.',409,'face_reference_duration_required')
      const media=await checkedMedia(item)
      return faceReferenceCall(()=>faceReferences.capture(channelId,{filePath:media.filePath,sourceItemId:id,durationSeconds}))
    },
    async updateFaceReference(id,value){return faceReferenceCall(()=>faceReferences.update(id,value))},
    async getFaceReferenceImage(id,options){return faceReferenceCall(()=>faceReferences.image(id,options))},
    async exportFaceReferences(channelId){await channels.get(channelId);return faceReferenceCall(()=>faceReferences.exportPack(channelId))},
    async getReaAsset(id,assetId) {
      if(typeof assetId!=='string'||!/^(storyboard|audio-chart|shot-\d{3})$/.test(assetId))throw fail('Rea Video image not found.',404,'not_found')
      return exclusive(async()=>{
        await load();const asset=find(id).result?.reaVideo?.assets?.find(value=>value.id===assetId)
        if(!asset||!['image/jpeg','image/png'].includes(asset.contentType)||typeof asset.dataBase64!=='string'||asset.dataBase64.length>350000||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(asset.dataBase64))throw fail('Rea Video image not found.',404,'not_found')
        const bytes=Buffer.from(asset.dataBase64,'base64'),png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),jpeg=bytes.length>3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255
        if(!bytes.length||bytes.length>256*1024||asset.contentType==='image/png'&&!png||asset.contentType==='image/jpeg'&&!jpeg)throw fail('Rea Video image not found.',404,'not_found')
        return {bytes,contentType:asset.contentType,filename:`rea-${assetId}.${png?'png':'jpg'}`}
      })
    },
    async getReaFrames(id,{startSeconds,endSeconds}={}) {
      const item=await exclusive(async()=>{await load();return clone(find(id))})
      if(!item.result?.reaVideo)throw fail('Run a Rea Video breakdown before inspecting its frames.',409,'rea_analysis_required')
      if(framesRunning)throw fail('A frame grid is already being prepared. Try again when it finishes.',429,'rea_frames_busy')
      framesRunning=true
      try {
        const media=await checkedMedia(item)
        return await createReaFrameGrid({filePath:media.filePath,durationSeconds:item.durationSeconds||item.result.metadata?.durationSeconds,startSeconds,endSeconds,config:currentConfig,signal:AbortSignal.timeout(90000)})
      } catch(error) {
        if(error instanceof VideoAnalysisError)throw error
        const safe=typeof error?.code==='string'&&(error.code.startsWith('rea_')||error.code==='analysis_cancelled')
        throw fail(safe?error.message:'The local frame grid could not be prepared. Check the configured runtime and media tools.',safe?error.status||503:503,safe?error.code:'rea_frames_failed')
      }
      finally {framesRunning=false}
    },
    async updateReaReview(id,value) {
      const fields=['summary','hook','payoff','characters','corrections']
      if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!fields.includes(key))||fields.some(key=>value[key]!==undefined&&(typeof value[key]!=='string'||value[key].length>4000||value[key].includes('\0'))))throw fail('Use text review notes of 4,000 characters or less per field.',400,'invalid_rea_review')
      return exclusive(async()=>{
        await load();const item=find(id)
        if(!item.result?.reaVideo)throw fail('Run a Rea Video breakdown before adding review notes.',409,'rea_analysis_required')
        if(['queued','importing','analyzing'].includes(item.status))throw fail('Wait for this analysis to finish before saving review notes.',409,'analysis_running')
        const previous=clone(item)
        item.result.reaVideo.reviewNotes={source:'user',updatedAt:now(),...Object.fromEntries(fields.map(key=>[key,(value[key]||'').trim()]))}
        // Keep authored notes when the user temporarily switches analysis workflows.
        item.reaReviewNotes=clone(item.result.reaVideo.reviewNotes)
        item.updatedAt=now()
        try{await persist()}catch(error){items[items.indexOf(item)]=previous;throw error}
        return publicItem(item)
      })
    },
    async listChannels(){const values=await exclusive(async()=>{await load();return clone(items)});return Promise.all((await channels.list()).map(channel=>channelWithImports(channel,values)))},
    async getChannel(id){const values=await exclusive(async()=>{await load();return clone(items)});return channelWithImports(await channels.get(id),values)},
    async addChannel(url){const channel=await channels.ensure(url);await channels.sync(channel.id);return service.getChannel(channel.id)},
    async syncChannel(id){await channels.sync(id);return service.getChannel(id)},
    async discoverChannel(id,options){await channels.startDiscovery(id,options);return service.getChannel(id)},
    async updateChannel(id,value){await channels.update(id,value);return service.getChannel(id)},
    async importAllChannelVideos(id){return batchExclusive(async()=>{try{await initialize();if(batchRunning(await bulkAnalyses.get()))throw fail('Channel analysis is running. Stop it or wait for it to finish before importing all videos.',409);const job=await bulkImports.start(id);return {job,channel:await service.getChannel(id)}}catch(error){throw fail(error.message,error.status,error.code)}})},
    async stopChannelImports(id){try{await channels.get(id);const job=await bulkImports.stop(id);return {job,channel:await service.getChannel(id)}}catch(error){throw fail(error.message,error.status,error.code)}},
    async analyzeAllChannelVideos(id,{analysisModelId,analysisWorkflowId,scriptTemplateId='none'}={}){return batchExclusive(async()=>{try{const template=resolveScriptTemplateId(scriptTemplateId);await initialize();await channels.get(id);if(batchRunning(await bulkImports.get()))throw fail('Channel import is running. Stop it or wait for it to finish before analyzing all videos.',409);const selection=Object.freeze({...selectAnalysis(currentConfig,{analysisModelId,analysisWorkflowId}),scriptTemplateId:template,scriptTemplateRevision:SCRIPT_TEMPLATE_REVISION});const job=await bulkAnalyses.start(id,{analysisModelId:selection.id,analysisWorkflowId:selection.workflowId,scriptTemplateId:template,context:selection});return {job,channel:await service.getChannel(id)}}catch(error){throw fail(error.message,error.status,error.code)}})},
    async stopChannelAnalyses(id){try{await channels.get(id);const job=await bulkAnalyses.stop(id);return {job,channel:await service.getChannel(id)}}catch(error){throw fail(error.message,error.status,error.code)}},
    async getChannelAvatar(id){return channels.avatar(id)},
    async getChannelThumbnail(id,code){return channels.thumbnail(id,code)},
    async assignChannel(id,channelId){
      if(channelId!==null)await channels.get(channelId)
      return exclusive(async()=>{await load();const item=find(id),owner=knownSourceChannel(item.source);if(owner&&channelId!==owner.id)throw fail(`This video belongs to @${owner.handle}. Its owner cannot be changed.`,409,'channel_owner_conflict');const previous=clone(item);item.source={...item.source};if(channelId===null)delete item.source.channelId;else item.source.channelId=channelId;item.updatedAt=now();try{await persist()}catch(error){items[items.indexOf(item)]=previous;throw error}return publicItem(item)})
    },
    async upload(stream,{filename,contentLength,contentType,channelId,reconstruction}={}) {
      if(channelId!==undefined)await channels.get(channelId)
      if(reconstruction){requireId(reconstruction.referenceId);requireId(reconstruction.jobId);await service.get(reconstruction.referenceId)}
      const safe=safeFilename(filename)
      if(contentType&& !/^(video\/|application\/octet-stream(?:;|$))/i.test(contentType)) throw fail('Upload the video file directly.',415,'unsupported_media')
      if(contentLength!==undefined&&(!Number.isSafeInteger(contentLength)||contentLength<1)) throw fail('Invalid upload size.',400)
      if(contentLength>VIDEO_ANALYSIS_LIMITS.maxUploadBytes) throw fail('Videos must be 150 MiB or smaller.',413,'upload_limit')
      const reservation=contentLength||VIDEO_ANALYSIS_LIMITS.maxUploadBytes,id=randomUUID(),mediaFile=`${id}${safe.extension}`,path=join(mediaRoot,mediaFile)
      await exclusive(async()=>{ await load(); if(items.length>=VIDEO_ANALYSIS_LIMITS.maxItems) throw fail('The reference library is full.',507,'storage_full'); if(await directoryBytes(storageRoot)+inflightUploadBytes+reservation>VIDEO_ANALYSIS_LIMITS.maxWorkspaceBytes) throw fail('The video workspace has reached its 2 GiB limit.',507,'storage_full'); inflightUploadBytes+=reservation })
      let bytes=0,success=false,handle
      try {
        handle=await open(path,'wx',0o600)
        // Keep the incoming HTTP stream intact on a limit error so the adapter can
        // send a useful 413 response rather than destroying its client socket.
        const iterator=typeof stream.iterator==='function'?stream.iterator({destroyOnReturn:false}):stream
        for await(const chunk of iterator) {
          bytes+=chunk.length
          if(bytes>VIDEO_ANALYSIS_LIMITS.maxUploadBytes||bytes>reservation) throw fail('Videos must be 150 MiB or smaller.',413,'upload_limit')
          await handle.writeFile(chunk)
        }
        await handle.close();handle=undefined
        if(!bytes||contentLength!==undefined&&bytes!==contentLength) throw fail('The upload was empty or incomplete.',400,'incomplete_upload')
        const timestamp=now(),item={id,title:safe.title,source:{kind:reconstruction?'reconstruction':'upload',filename:safe.filename,...(channelId?{channelId}:{}),...(reconstruction?{referenceId:reconstruction.referenceId,reconstructionId:reconstruction.jobId}:{})},status:'ready',createdAt:timestamp,updatedAt:timestamp,mediaFile,bytes}
        await exclusive(async()=>{await load(); if(items.length>=VIDEO_ANALYSIS_LIMITS.maxItems) throw fail('The reference library is full.',507,'storage_full'); items.push(item); try{await persist()}catch(error){items.pop();throw error} })
        success=true; return publicItem(item)
      } finally { await handle?.close().catch(()=>{}); inflightUploadBytes-=reservation; if(!success) await unlink(path).catch(()=>{}) }
    },
    async importUrl(raw,{channelId}={}) {
      const validated=safeUrl(raw)
      const url=currentImporter?.classifyVideoUrl?safeUrl(currentImporter.classifyVideoUrl(validated).url.href):validated
      if(channelId!==undefined)await channels.get(channelId)
      const knownOwner=knownSourceChannel({url})
      if(knownOwner){await channels.ensure(knownOwner.url);channelId=knownOwner.id}
      return exclusive(async()=>{
        await load()
        const duplicate=items.find(item=>item.source?.url===url&&['queued','importing','analyzing','ready','complete','partial'].includes(item.status)||item.source?.requestedUrl===url&&['queued','importing'].includes(item.status))
        if(duplicate) return publicItem(duplicate)
        if(items.length>=VIDEO_ANALYSIS_LIMITS.maxItems) throw fail('The reference library is full.',507,'storage_full')
        const slot=reserveQueue()
        const timestamp=now(),item={id:randomUUID(),title:new URL(url).hostname,source:{kind:'url',url,...(channelId?{channelId}:{})},status:'queued',progress:'Waiting to import…',pendingAction:'import',createdAt:timestamp,updatedAt:timestamp}
        items.push(item); try { await persist();slot.enqueue(()=>importJob(item.id,url)) } catch(error) {items.pop();slot.release();throw error}
        return publicItem(item)
      })
    },
    async analyze(id,{mode='both',analysisModelId,analysisWorkflowId,scriptTemplateId='none'}={}) {let selection;try{const template=resolveScriptTemplateId(scriptTemplateId);selection=Object.freeze({...selectAnalysis(currentConfig,{analysisModelId,analysisWorkflowId}),scriptTemplateId:template,scriptTemplateRevision:SCRIPT_TEMPLATE_REVISION})}catch(error){throw fail(error.message,error.status,error.code)}return queueAnalysis(id,{mode},selection)},
    async getMedia(id) { const item=await exclusive(async()=>{await load();return clone(find(id))}); return checkedMedia(item) },
    async exportItem(id,{format='txt'}={}) { const item=await exclusive(async()=>{await load();return clone(find(id))}); return {...createReelTextExport(item,format),filename:`spur-video-${id}.${format}`} },
    async reconstructionPlan(id,value){return reconstructionCall(()=>reconstructions.plan(id,value))},
    async createReconstruction(id,value){return reconstructionCall(()=>reconstructions.create(id,value))},
    async listReconstructions({referenceId}={}){return reconstructionCall(()=>reconstructions.list(referenceId))},
    async getReconstruction(id){return reconstructionCall(()=>reconstructions.get(id))},
    async getReconstructionMedia(id){return reconstructionCall(()=>reconstructions.getMedia(id))},
    async analyzeReconstruction(id){return reconstructionCall(()=>reconstructions.analyzeOutput(id))},
    async resumeReconstruction(id){return reconstructionCall(()=>reconstructions.resume(id))},
    async whenIdle(){await bulkImports.whenIdle();await bulkAnalyses.whenIdle();await reconstructions.whenIdle();await waitForVideoAnalysisIdle()},
  }
  reconstructions=createReconstructionService({root:storageRoot,referenceService:service,config:currentConfig,getConfig:()=>currentConfig})
  services.set(storageRoot,service)
  return service
}
