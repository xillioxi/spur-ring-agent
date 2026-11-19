import test from 'node:test'
import assert from 'node:assert/strict'
import {createOutlookProvider,finishOutlookOAuth} from './outlook.mjs'

const root=process.cwd(),clientId='11111111-2222-4333-8444-555555555555',address='owner@outlook.com'
const graphId='AAMkAGVmMDEzMTM4LTZmYWUtNDdkNC1hMDZiLTU1OGY5OTZhYmY4OABGAAAAAAAiQ8W967B7TKBjgx9rVEURBwAiIsqMbYjsT5e-T7KzowPTAAAAAAEMAAAiIsqMbYjsT5e-T7KzowPTAASoXUT3AAA='
const publicId=value=>'ms_'+Buffer.from(value).toString('base64url')
const json=(value,status=200,headers={})=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json',...headers}})
function memoryStore(value=null){return {storage:'session',async get(){return value?structuredClone(value):null},async set(next){value=structuredClone(next)},async clear(){value=null}}}
const saved=overrides=>({method:'outlook_oauth',email:address,accountId:'outlook_synthetic_identity',connectedAt:'2026-11-17T04:00:00Z',clientId,accessToken:'synthetic-access-token',refreshToken:'synthetic-refresh-token',expiresAt:Date.now()+3600000,...overrides})
function mail(id=graphId,overrides={}){return {id,internetMessageId:'<original@outlook.com>',conversationId:'AAABBBCCC=',from:{emailAddress:{name:'Alice',address:'ALICE@example.com'}},toRecipients:[{emailAddress:{name:'Owner',address}}],ccRecipients:[],subject:'Real-shaped Outlook email',receivedDateTime:'2026-11-16T09:00:00Z',isDraft:false,parentFolderId:'inbox',...overrides}}
function folders(url){
  const name=url.pathname.split('/').at(-1)
  return ['junkemail','deleteditems','drafts'].includes(name)?json({id:name,childFolderCount:0}):null
}

test('Microsoft sign-in uses read-only delegated scopes, fixed callback and PKCE without exposing a client secret',async()=>{
  const store=memoryStore(),calls=[]
  const fetchImpl=async(raw,options)=>{
    const url=new URL(raw);calls.push({url,options})
    if(url.hostname==='login.microsoftonline.com')return json({access_token:'new-synthetic-token',refresh_token:'new-synthetic-refresh',scope:'Mail.Read User.Read',expires_in:3600})
    if(url.pathname==='/v1.0/me')return json({id:'stable-object-id',mail:address,userPrincipalName:'fallback@example.com'})
    throw Error('unexpected request')
  }
  const provider=createOutlookProvider({root,credentials:store,fetchImpl,config:{OUTLOOK_CLIENT_ID:clientId,OUTLOOK_CLIENT_SECRET:'synthetic-client-secret'}})
  const start=await provider.startOAuth(),url=new URL(start.authorizationUrl),params=new URLSearchParams({state:url.searchParams.get('state'),code:'synthetic-code'})
  assert.equal(url.hostname,'login.microsoftonline.com');assert.equal(url.pathname,'/common/oauth2/v2.0/authorize')
  assert.equal(url.searchParams.get('redirect_uri'),'http://127.0.0.1:4173/api/email-memory/outlook/callback')
  assert.equal(url.searchParams.get('code_challenge_method'),'S256')
  assert.match(url.searchParams.get('scope'),/Mail\.Read/);assert.match(url.searchParams.get('scope'),/offline_access/);assert.doesNotMatch(url.searchParams.get('scope'),/Mail\.Send|Write|ReadWrite/i)
  assert.equal(start.authorizationUrl.includes('synthetic-client-secret'),false)
  const result=await finishOutlookOAuth(params)
  assert.equal(result.provider,'outlook');assert.equal(result.email,address);assert.equal(result.method,'outlook_oauth');assert.match(result.accountId,/^outlook_[a-f0-9]{24}$/)
  assert.equal(JSON.stringify(result).includes('new-synthetic-token'),false)
  assert.equal(calls[0].options.body.get('client_secret'),'synthetic-client-secret')
  assert.equal(calls[1].options.headers.authorization,'Bearer new-synthetic-token')
  await assert.rejects(finishOutlookOAuth(params),{code:'outlook_invalid_state'})
})

test('an own public application client ID can authorize without a host secret and is validated before any requests',async()=>{
  const provider=createOutlookProvider({root,credentials:memoryStore(),fetchImpl:async()=>{throw Error('not used')}})
  const status=await provider.status();assert.equal(status.clientIdRequired,true);assert.equal(status.oauthAvailable,true)
  for(const invalid of ['arbitrary-client','https://attacker.example/app','11111111-2222-4333-8444-555555555555\r\nHeader:bad'])await assert.rejects(provider.startOAuth({clientId:invalid}),{code:'outlook_client_required'})
  const started=await provider.startOAuth({clientId}),url=new URL(started.authorizationUrl)
  assert.equal(url.searchParams.get('client_id'),clientId)
  await assert.rejects(provider.finishOAuth(new URLSearchParams({state:url.searchParams.get('state'),error:'access_denied'})),{code:'outlook_oauth_cancelled'})
  await assert.rejects(provider.finishOAuth(new URLSearchParams({state:url.searchParams.get('state'),code:'reuse'})),{code:'outlook_invalid_state'})
})

test('all Outlook pages preserve immutable IDs and exclude Junk, Deleted, Drafts and their subfolders',async()=>{
  const calls=[],store=memoryStore(saved())
  const fetchImpl=async(raw,options)=>{
    const url=new URL(raw);calls.push({url,options})
    if(url.pathname.endsWith('/mailFolders/deleteditems'))return json({id:'deleteditems',childFolderCount:1})
    const folder=folders(url);if(folder)return folder
    if(url.pathname.endsWith('/mailFolders/deleteditems/childFolders'))return json({value:[{id:'deleted-child',childFolderCount:0}]})
    if(url.pathname==='/v1.0/me/messages'){
      if(url.searchParams.get('$skiptoken'))return json({value:[mail('second-message-ID=')]})
      const next=new URL(url);next.searchParams.set('$skiptoken','opaque-next')
      return json({value:[mail(),mail('junk-ID=',{parentFolderId:'junkemail'}),mail('deleted-ID=',{parentFolderId:'deleted-child'}),mail('draft-ID=',{isDraft:true,parentFolderId:'drafts'})],'@odata.nextLink':next.href})
    }
    throw Error('unexpected request')
  }
  const provider=createOutlookProvider({root,credentials:store,fetchImpl})
  const first=await provider.scanPage(),second=await provider.scanPage({cursor:first.nextCursor})
  assert.equal(first.messages.length,1);assert.equal(first.messages[0].id,publicId(graphId));assert.equal(first.messages[0].from.email,'alice@example.com')
  assert.equal(first.messages[0].internetMessageId,'<original@outlook.com>');assert.equal(first.mailboxAccountId,'outlook_synthetic_identity')
  assert.equal(second.messages.length,1);assert.equal(second.hasNextPage,false)
  for(const call of calls){assert.equal(call.url.hostname,'graph.microsoft.com');assert.equal(call.options.headers.prefer,'IdType="ImmutableId"');assert.equal(call.url.href.includes('synthetic-access-token'),false)}
  assert.equal(calls.filter(call=>call.url.pathname.endsWith('/mailFolders/deleteditems')).length,1)
  assert.equal(calls.filter(call=>call.url.pathname==='/v1.0/me/messages').every(call=>!call.url.searchParams.get('$select').split(',').includes('body')),true)
})

test('unsafe, foreign, credential-bearing and body-expanding next links are rejected before they can be followed',async()=>{
  for(const unsafe of ['https://attacker.example/v1.0/me/messages','https://user:password@graph.microsoft.com/v1.0/me/messages','http://graph.microsoft.com/v1.0/me/messages','https://graph.microsoft.com/beta/me/messages','https://graph.microsoft.com/v1.0/users/another-user/messages','https://graph.microsoft.com/v1.0/me/messages?$select=body','https://graph.microsoft.com/v1.0/me/messages?$expand=attachments','https://graph.microsoft.com/v1.0/me/messages?access_token=secret']){
    const calls=[],provider=createOutlookProvider({root,credentials:memoryStore(saved()),fetchImpl:async raw=>{const url=new URL(raw);calls.push(url);const folder=folders(url);return folder||json({value:[mail()],'@odata.nextLink':unsafe})}})
    await assert.rejects(provider.scanPage(),{code:'outlook_invalid_cursor'})
    assert.equal(calls.some(url=>url.hostname!=='graph.microsoft.com'),false)
    assert.equal(calls.filter(url=>url.pathname==='/v1.0/me/messages').length,1)
  }
})

test('saved page cursors cannot be resumed with a different Microsoft identity sharing the same email address',async()=>{
  const store=memoryStore(saved()),provider=createOutlookProvider({root,credentials:store,fetchImpl:async raw=>{const url=new URL(raw),folder=folders(url);if(folder)return folder;const next=new URL(url);next.searchParams.set('$skiptoken','next');return json({value:[mail()],'@odata.nextLink':next.href})}})
  const first=await provider.scanPage();await store.set(saved({accountId:'outlook_different_identity'}))
  await assert.rejects(provider.scanPage({cursor:first.nextCursor}),{code:'outlook_account_changed'})
  await assert.rejects(provider.scanPage({cursor:'../../outside'}),{code:'outlook_invalid_cursor'})
})

test('opening a message requests only text content, preserves long case-sensitive identifiers and never exposes HTML',async()=>{
  const calls=[],provider=createOutlookProvider({root,credentials:memoryStore(saved()),fetchImpl:async(raw,options)=>{calls.push({url:new URL(raw),options});return json(mail(graphId,{body:{contentType:'html',content:'<p>Actual message text</p><img src="https://attacker.example/pixel">'}}))}})
  const result=await provider.getMessage(publicId(graphId))
  assert.equal(result.id,publicId(graphId));assert.match(result.text,/Actual message text/);assert.doesNotMatch(result.text,/<p>|<img/)
  assert.equal(result.attachmentsOmitted,true);assert.equal(result.mailboxEmail,address);assert.equal(result.mailboxAccountId,'outlook_synthetic_identity')
  assert.equal(calls.length,1);assert.equal(calls[0].url.pathname,'/v1.0/me/messages/'+encodeURIComponent(graphId))
  assert.match(calls[0].options.headers.prefer,/outlook\.body-content-type="text"/)
  assert.equal(calls[0].url.href.includes('attachments'),false)
  await assert.rejects(provider.getMessage('ms_not-valid-canonical-encoding'),{status:400})
})

test('Outlook refresh tokens rotate without leaking secrets or changing the connected account',async()=>{
  const store=memoryStore(saved({expiresAt:0})),calls=[],provider=createOutlookProvider({root,credentials:store,fetchImpl:async(raw,options)=>{
    const url=new URL(raw);calls.push({url,options})
    if(url.hostname==='login.microsoftonline.com')return json({access_token:'rotated-token',refresh_token:'rotated-refresh',scope:'Mail.Read User.Read',expires_in:3600})
    return json(mail(graphId,{body:{contentType:'text',content:'Actual text'}}))
  }})
  await provider.getMessage(publicId(graphId))
  assert.equal(calls[0].options.body.get('grant_type'),'refresh_token');assert.equal(calls[0].options.body.has('client_secret'),false)
  assert.equal(calls[1].options.headers.authorization,'Bearer rotated-token')
  const current=await store.get();assert.equal(current.refreshToken,'rotated-refresh');assert.equal(current.accountId,'outlook_synthetic_identity')
  assert.equal(JSON.stringify(await provider.status()).includes('rotated'),false)
})

test('rate limits, auth failures, oversized responses and cancellation fail safely without echoing diagnostics',async()=>{
  for(const [status,code]of [[429,'outlook_rate_limited'],[401,'outlook_auth_required'],[403,'outlook_permission_required']]){
    const provider=createOutlookProvider({root,credentials:memoryStore(saved()),fetchImpl:async()=>json({error:{message:'synthetic-private-secret'}},status)})
    await assert.rejects(provider.getMessage(publicId(graphId)),error=>error.code===code&&!error.message.includes('synthetic-private-secret'))
  }
  const oversized=createOutlookProvider({root,credentials:memoryStore(saved()),fetchImpl:async()=>json({},200,{'content-length':String(5*1024*1024)})})
  await assert.rejects(oversized.getMessage(publicId(graphId)),{status:502})
  let calls=0
  const cancelled=createOutlookProvider({root,credentials:memoryStore(saved()),fetchImpl:async()=>{calls++;return json({})}})
  await assert.rejects(cancelled.scanPage({signal:AbortSignal.abort()}),{status:499});assert.equal(calls,0)
})

test('disconnect removes only this Outlook connection and invalidates pending sign-in state',async()=>{
  const store=memoryStore(saved()),provider=createOutlookProvider({root,credentials:store,config:{MICROSOFT_CLIENT_ID:clientId},fetchImpl:async()=>{throw Error('not used')}})
  const start=await provider.startOAuth(),state=new URL(start.authorizationUrl).searchParams.get('state')
  assert.equal((await provider.disconnect()).connected,false);assert.equal(await store.get(),null)
  await assert.rejects(finishOutlookOAuth(new URLSearchParams({state,code:'synthetic'})),{code:'outlook_invalid_state'})
})
