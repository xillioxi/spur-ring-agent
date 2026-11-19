import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import plugin from '../../agent/tools/video-analysis/index.cjs'

test('native tools use the scoped host API and preserve asynchronous receipts', async t => {
  const calls = []
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    calls.push({ path: req.url, token: req.headers['x-spur-video-tool'], method: req.method, body: body ? JSON.parse(body) : null })
    res.writeHead(req.method === 'POST' ? 202 : 200, { 'Content-Type': 'application/json' })
    const bulk=/\/channels\/(?:instagram|tiktok)-[a-z0-9_.]+\/(?:import-all|analyze-all)(?:\/stop)?$/.test(req.url)
    res.end(JSON.stringify(req.url.endsWith('/status') ? { defaultAnalysisModelId: 'siliconflow-qwen3-omni-thinking', analysisModels: [{ id: 'poe-gemini-3.7-flash', available: false, reason: 'The provider does not allow API access to this bot.' }, { id: 'siliconflow-qwen3-omni-thinking', available: true }] } : bulk ? { job: { id: 'batch-receipt', status: req.url.endsWith('/stop') ? 'stopping' : 'running' }, channel: { id: 'tiktok-ez_home' } } : req.method === 'POST' ? { item: { id: '12345678-1234-1234-1234-123456789abc', status: 'queued' } } : { items: [] }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const previous = { endpoint: process.env.SPUR_VIDEO_ANALYSIS_ENDPOINT, token: process.env.SPUR_VIDEO_ANALYSIS_TOOL_TOKEN }
  t.after(() => {
    for (const [name, value] of [['SPUR_VIDEO_ANALYSIS_ENDPOINT', previous.endpoint], ['SPUR_VIDEO_ANALYSIS_TOOL_TOKEN', previous.token]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value
    }
  })
  process.env.SPUR_VIDEO_ANALYSIS_ENDPOINT = `http://127.0.0.1:${server.address().port}/api/creator-agent/video-analysis`
  process.env.SPUR_VIDEO_ANALYSIS_TOOL_TOKEN = 'synthetic-scoped-test-token'
  const tools = new Map()
  await plugin.apply({ tools: { register(tool) { tools.set(tool.name, tool) } } })
  assert.equal(tools.size, 22)
  assert.equal((await tools.get('video_reference_list').execute({})).ok, true)
  const receipt = await tools.get('video_reference_analyze').execute({ id: '12345678-1234-1234-1234-123456789abc', mode: 'script' })
  assert.equal(receipt.result.item.status, 'queued')
  assert.deepEqual(calls[1].body, { mode: 'script' })
  assert.equal(calls[1].token, 'synthetic-scoped-test-token')
  assert.equal((await tools.get('video_reference_get').execute({ id: '../../outside' })).ok, false)
  assert.equal(calls.length, 2)
  assert.equal((await tools.get('video_channel_list').execute({})).ok, true)
  assert.equal((await tools.get('video_channel_set_style').execute({ channelId: 'instagram-gdarusa', style: { generationMethod: 'footage_edit', direction: 'Reflective travel journal' } })).ok, true)
  assert.deepEqual(calls[3].body, { style: { generationMethod: 'footage_edit', direction: 'Reflective travel journal' } })
  assert.equal(calls[3].method, 'PATCH')
  assert.equal(calls[3].path, '/api/creator-agent/video-analysis/channels/instagram-gdarusa')
  assert.equal((await tools.get('video_reference_import').execute({ url: 'https://www.instagram.com/reel/example/', channelId: 'instagram-gdarusa' })).ok, true)
  assert.equal(calls[4].body.channelId, 'instagram-gdarusa')
  assert.equal((await tools.get('video_reference_assign').execute({ id: '12345678-1234-1234-1234-123456789abc', channelId: null })).ok, true)
  assert.deepEqual(calls[5].body, { channelId: null })
  const length = calls.length
  assert.equal((await tools.get('video_channel_get').execute({ channelId: '../../outside' })).ok, false)
  assert.equal(calls.length, length)
  const discovery=await tools.get('video_channel_discover').execute({channelId:'instagram-gdarusa',resume:true})
  assert.equal(discovery.ok,true)
  assert.equal(calls.at(-1).path,'/api/creator-agent/video-analysis/channels/instagram-gdarusa/discover')
  assert.deepEqual(calls.at(-1).body,{resume:true})
  for(const [name,action] of [['video_channel_import_all','import-all'],['video_channel_stop_imports','import-all/stop'],['video_channel_analyze_all','analyze-all'],['video_channel_stop_analysis','analyze-all/stop']]){
    const tool=tools.get(name),receipt=await tool.execute({channelId:'tiktok-ez_home'})
    assert.equal(receipt.ok,true);assert.equal(receipt.result.job.id,'batch-receipt')
    assert.equal(receipt.result.job.status,action.endsWith('/stop')?'stopping':'running','a receipt must retain its asynchronous state')
    assert.deepEqual(calls.at(-1),{path:`/api/creator-agent/video-analysis/channels/tiktok-ez_home/${action}`,method:'POST',body:{},token:'synthetic-scoped-test-token'})
    assert.equal(tool.parameters.additionalProperties,false);assert.deepEqual(tool.parameters.required,['channelId'])
    assert.match(tool.description,/video_channel_get/)
    const before=calls.length
    for(const args of [{channelId:'../../outside'},{channelId:'tiktok-ez_home/analyze-all'},{channelId:'tiktok-ez_home?root=elsewhere'},{channelId:'youtube-unregistered'},{channelId:'tiktok-ez_home',itemIds:['12345678-1234-1234-1234-123456789abc']},{channelId:'tiktok-ez_home',urls:['https://localhost/private']},{channelId:'tiktok-ez_home',root:'C:/private'},{},null])assert.equal((await tool.execute(args)).ok,false)
    assert.equal(calls.length,before,'invalid bulk arguments must not contact the host')
  }
  assert.equal((await tools.get('video_channel_get').execute({channelId:'tiktok-ez_home'})).ok,true)
  assert.equal(calls.at(-1).path,'/api/creator-agent/video-analysis/channels/tiktok-ez_home')
  assert.equal(calls.at(-1).method,'GET')
  assert.ok(tools.get('video_reference_analyze').parameters.properties.mode.enum.includes('audio'))
  const audio=await tools.get('video_reference_analyze').execute({id:'12345678-1234-1234-1234-123456789abc',mode:'audio'})
  assert.equal(audio.ok,true)
  assert.deepEqual(calls.at(-1).body,{mode:'audio'})
  const registeredId='12345678-1234-1234-1234-123456789abc'
  assert.equal((await tools.get('video_recreation_plan').execute({id:registeredId})).ok,true)
  assert.equal(calls.at(-1).path,`/api/creator-agent/video-analysis/items/${registeredId}/reconstruction-plan`)
  assert.equal(calls.at(-1).method,'GET')
  const authored=[{startSeconds:0,endSeconds:3.6,prompt:'[Shake] A spacecraft porthole.'},{startSeconds:3.7,endSeconds:11.6,prompt:'[Pedestal down] Through a checkerboard trapdoor.'}]
  assert.equal((await tools.get('video_recreation_plan').execute({id:registeredId,timeline:authored})).ok,true)
  assert.equal(calls.at(-1).method,'POST')
  assert.deepEqual(calls.at(-1).body,{timeline:authored})
  const beforeInvalidGeneration=calls.length
  assert.equal((await tools.get('video_recreation_generate').execute({id:registeredId,requestKey:'bad',planRevision:'revision'})).ok,false)
  assert.equal(calls.length,beforeInvalidGeneration)
  const generationArgs={id:registeredId,requestKey:'22345678-1234-1234-1234-123456789abc',planRevision:'revision',shots:[{index:0,prompt:'A person walks toward a green vortex.'}],audioMode:'reference',resolution:'480p'}
  assert.equal((await tools.get('video_recreation_generate').execute(generationArgs)).ok,true)
  assert.deepEqual(calls.at(-1).body,{requestKey:generationArgs.requestKey,planRevision:'revision',shots:generationArgs.shots,audioMode:'reference',resolution:'480p'})
  assert.equal(calls.at(-1).token,'synthetic-scoped-test-token')
  assert.match(tools.get('video_recreation_generate').description,/paid|stable UUID|never generate again/)
  assert.equal((await tools.get('video_recreation_generate').execute({...generationArgs,timeline:authored})).ok,true)
  assert.deepEqual(calls.at(-1).body.timeline,authored)
  const beforeInvalidTimeline=calls.length
  for(const name of ['video_recreation_plan','video_recreation_generate']){
    const args=name==='video_recreation_plan'?{id:registeredId}:generationArgs
    for(const timeline of [null,[],Array(25).fill(authored[0]),[{...authored[0],model:'other'}],[{...authored[0],images:[{url:'https://your-storage.url/placeholder.png'}]}],[{...authored[0],startSeconds:-1}],[{...authored[0],endSeconds:16}],[{...authored[0],prompt:'  '}],[{...authored[0],prompt:'x'.repeat(8001)}],[authored[0],{...authored[1],startSeconds:3}],[{...authored[0],endSeconds:0.01}]] )assert.equal((await tools.get(name).execute({...args,timeline})).ok,false)
    assert.equal((await tools.get(name).execute({...args,timeline:authored,apiKey:'client-secret'})).ok,false)
  }
  assert.equal(calls.length,beforeInvalidTimeline,'invalid authored timelines must not contact the host')
  assert.equal((await tools.get('video_recreation_list').execute({referenceId:registeredId})).ok,true)
  assert.equal(calls.at(-1).path,`/api/creator-agent/video-analysis/reconstructions?referenceId=${registeredId}`)
  assert.equal((await tools.get('video_recreation_get').execute({id:registeredId})).ok,true)
  assert.equal(calls.at(-1).path,`/api/creator-agent/video-analysis/reconstructions/${registeredId}`)
  assert.equal((await tools.get('video_recreation_analyze').execute({id:registeredId})).ok,true)
  assert.deepEqual(calls.at(-1).body,{})
  assert.equal(calls.at(-1).method,'POST')
  assert.equal((await tools.get('video_recreation_resume').execute({id:registeredId})).ok,true)
  assert.equal(calls.at(-1).path,`/api/creator-agent/video-analysis/reconstructions/${registeredId}/resume`)
  assert.deepEqual(calls.at(-1).body,{})
  const status=await tools.get('video_analysis_status').execute({})
  assert.equal(status.ok,true);assert.equal(status.result.defaultAnalysisModelId,'siliconflow-qwen3-omni-thinking')
  assert.equal(status.result.analysisModels[0].available,false)
  assert.match(status.result.analysisModels[0].reason,/API access/)
  assert.equal(calls.at(-1).path,'/api/creator-agent/video-analysis/status');assert.equal(calls.at(-1).method,'GET')
  for(const name of ['video_reference_analyze','video_channel_analyze_all']){
    const tool=tools.get(name),args=name==='video_reference_analyze'?{id:registeredId,mode:'both'}:{channelId:'tiktok-ez_home'}
    assert.ok(tool.parameters.properties.analysisModelId.enum.includes('poe-gemini-3.7-flash'))
    assert.equal(tool.parameters.properties.analysisModelId.enum.includes('poe-gemini-4-argon'),false)
    assert.match(tool.description,/video_analysis_status/)
    const selected=await tool.execute({...args,analysisModelId:'siliconflow-qwen3-omni-thinking'})
    assert.equal(selected.ok,true);assert.equal(calls.at(-1).body.analysisModelId,'siliconflow-qwen3-omni-thinking')
    assert.equal((await tool.execute({...args,analysisModelId:'poe-gemini-3.7-flash'})).ok,true)
    assert.equal(calls.at(-1).body.analysisModelId,'poe-gemini-3.7-flash')
    assert.equal(tool.parameters.properties.scriptTemplateId.type,'string')
    assert.match(tool.parameters.properties.scriptTemplateId.description,/default nine-column production breakdown without narrative matching/)
    const structured=await tool.execute({...args,analysisModelId:'siliconflow-qwen3-omni-thinking',scriptTemplateId:'xc-1'})
    assert.equal(structured.ok,true)
    assert.equal(calls.at(-1).body.scriptTemplateId,'xc-1')
    assert.equal(calls.at(-1).body.analysisModelId,'siliconflow-qwen3-omni-thinking')
    assert.equal((await tool.execute({...args,scriptTemplateId:'none'})).ok,true)
    assert.equal(calls.at(-1).body.scriptTemplateId,'none')
    const before=calls.length
    for(const analysisModelId of ['Gemini-3.7-Flash','poe-gemini-4-argon','https://evil.example/v1','sk-poe-private-key',{},null])assert.equal((await tool.execute({...args,analysisModelId})).ok,false)
    for(const extra of [{apiKey:'private'},{provider:'poe'},{baseUrl:'https://evil.example/v1'},{model:'Gemini-3.7-Flash'}])assert.equal((await tool.execute({...args,...extra})).ok,false)
    for(const scriptTemplateId of ['', 'https://evil.example/prompt', 'xc-1; command', 'x'.repeat(65), {}, [], null])assert.equal((await tool.execute({...args,scriptTemplateId})).ok,false)
    for(const extra of [{scriptTemplate:{stages:[]}},{prompt:'client-authored system prompt'},{sourceFile:'C:/private.xlsx'}])assert.equal((await tool.execute({...args,scriptTemplateId:'xc-1',...extra})).ok,false)
    assert.equal(calls.length,before,'unregistered model settings must not contact the host')
  }
  const beforeRejected=calls.length
  for(const name of ['video_channel_import_all','video_channel_stop_imports','video_channel_stop_analysis']){
    assert.equal((await tools.get(name).execute({channelId:'tiktok-ez_home',analysisModelId:'poe-gemini-3.7-flash'})).ok,false)
    assert.equal((await tools.get(name).execute({channelId:'tiktok-ez_home',scriptTemplateId:'xc-1'})).ok,false)
  }
  assert.equal((await tools.get('video_reference_analyze').execute({id:registeredId,mode:'train'})).ok,false)
  assert.equal((await tools.get('video_analysis_status').execute({apiKey:'private'})).ok,false)
  assert.equal(calls.length,beforeRejected)
})

test('native video tools require a private loopback endpoint and host token before registering',async t=>{
  const previous={endpoint:process.env.SPUR_VIDEO_ANALYSIS_ENDPOINT,token:process.env.SPUR_VIDEO_ANALYSIS_TOOL_TOKEN}
  t.after(()=>{
    for(const [name,value] of [['SPUR_VIDEO_ANALYSIS_ENDPOINT',previous.endpoint],['SPUR_VIDEO_ANALYSIS_TOOL_TOKEN',previous.token]])if(value===undefined)delete process.env[name];else process.env[name]=value
  })
  let registrations=0
  const context={tools:{register(){registrations++}}}
  for(const endpoint of ['https://example.com/api/creator-agent/video-analysis','http://localhost:4173/api/creator-agent/video-analysis','http://user:password@127.0.0.1:4173/api/creator-agent/video-analysis']){
    process.env.SPUR_VIDEO_ANALYSIS_ENDPOINT=endpoint;process.env.SPUR_VIDEO_ANALYSIS_TOOL_TOKEN='synthetic-scoped-test-token'
    await assert.rejects(plugin.apply(context),/private local video analysis host/)
  }
  process.env.SPUR_VIDEO_ANALYSIS_ENDPOINT='http://127.0.0.1:4173/api/creator-agent/video-analysis'
  delete process.env.SPUR_VIDEO_ANALYSIS_TOOL_TOKEN
  await assert.rejects(plugin.apply(context),/private local video analysis host/)
  assert.equal(registrations,0)
})
