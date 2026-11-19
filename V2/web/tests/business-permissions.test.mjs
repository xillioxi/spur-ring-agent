import test from 'node:test'
import assert from 'node:assert/strict'
import {connectorConfig,integrationAccess} from '../business-permissions.mjs'

const state=(ai_read=true,ai_write=false,ai_enabled=true)=>({settings:{ai_enabled},modules:[{id:'integrations',available:true,permissions:{ai_read,ai_write}}]})
test('existing connector access follows global/read/write grants independently',()=>{
  assert.deepEqual(integrationAccess(state()),{read:true,write:false})
  assert.deepEqual(integrationAccess(state(true,true)),{read:true,write:true})
  assert.deepEqual(integrationAccess(state(false,true)),{read:false,write:false})
  assert.deepEqual(integrationAccess(state(true,true,false)),{read:false,write:false})
  assert.deepEqual(integrationAccess({settings:{ai_enabled:true},modules:[]}),{read:false,write:false})
})
test('denied connector credentials cannot enter the model prompt or child environment configuration',()=>{
  const config={SILICONFLOW_API_KEY:'model-key',NOTION_TOKEN:'private-notion',YOUTUBE_ACCESS_TOKEN:'private-youtube',YOUTUBE_API_KEY:'youtube-key',YOUTUBE_CLIENT_SECRET:'secret'}
  const denied=connectorConfig(config,state(false))
  assert.equal(denied.SILICONFLOW_API_KEY,'model-key')
  for(const key of ['NOTION_TOKEN','YOUTUBE_ACCESS_TOKEN','YOUTUBE_API_KEY','YOUTUBE_CLIENT_SECRET'])assert.equal(denied[key],'')
  assert.equal(config.NOTION_TOKEN,'private-notion','Do not mutate installation configuration')
  assert.equal(connectorConfig(config,state()).NOTION_TOKEN,'private-notion')
})
