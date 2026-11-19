import test from 'node:test'
import assert from 'node:assert/strict'
import {Readable} from 'node:stream'
import {createGmailProvider,finishGmailOAuth} from './gmail.mjs'

const root=process.cwd(),account='owner@example.com',password='abcdefghijklmnop'
function memoryStore(){let value=null;return {storage:'session',async get(){return value?structuredClone(value):null},async set(next){value=structuredClone(next)},async clear(){value=null}}}
function fakeImap({exists=205,uidNext=206,validity='77',failConnect=false,sparseUids}={}){
  const calls=[]
  const factory=options=>({
    on(){},mailbox:{exists,uidNext,uidValidity:BigInt(validity)},
    async connect(){calls.push({action:'connect',options});if(failConnect)throw Object.assign(new Error('credentials exposed abcdefghijklmnop'),{authenticationFailed:true})},
    async list(){return [{path:'[Gmail]/All Mail',specialUse:'\\All'}]},
    async getMailboxLock(path,options){calls.push({action:'lock',path,options});return {release(){calls.push({action:'release'})}}},
    async *fetch(range,query,options){calls.push({action:'fetch',range,query,options});for(const uid of range.split(',').map(Number))yield record(uid)},
    async search(query,options){calls.push({action:'search',query,options});return query.emailId?[1]:sparseUids||Array.from({length:exists},(_,index)=>index+1)},
    async fetchOne(range,query,options){calls.push({action:'fetchOne',range,query,options});return {...record(1),bodyStructure:{type:'multipart/mixed',childNodes:[{part:'1',type:'text/plain',size:19},{part:'2',type:'application/pdf',disposition:'attachment',dispositionParameters:{filename:'private-attachment.pdf'},size:5000000}]}}},
    async download(range,part,options){calls.push({action:'download',range,part,options});return {meta:{contentType:'text/plain'},content:Readable.from([Buffer.from('Actual message text')])}},
    async logout(){calls.push({action:'logout'})},close(){calls.push({action:'close'})},
  })
  function record(uid){return {uid,emailId:String(100000+uid),threadId:'1234',size:120,internalDate:new Date('2026-11-01T12:00:00Z'),labels:new Set(['\\Inbox']),envelope:{from:[{name:'Alice',address:'ALICE@example.com'}],to:[{address:account}],cc:[],subject:'An actual email '+uid,messageId:`<msg-${uid}@example.com>`}}}
  return {factory,calls}
}
const json=value=>new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}})

test('Gmail app-password connection uses strict fixed-host TLS, read-only All Mail and never returns credentials',async()=>{
  const fake=fakeImap(),provider=createGmailProvider({root,credentials:memoryStore(),imapFactory:fake.factory})
  assert.equal((await provider.status()).connected,false)
  const status=await provider.connectAppPassword({email:'OWNER@example.com',appPassword:'abcd efgh ijkl mnop'})
  assert.equal(status.connected,true);assert.equal(status.email,account);assert.equal(status.method,'gmail_imap');assert.equal(JSON.stringify(status).includes(password),false)
  const connect=fake.calls.find(call=>call.action==='connect'),lock=fake.calls.find(call=>call.action==='lock')
  assert.equal(connect.options.host,'imap.gmail.com');assert.equal(connect.options.port,993);assert.equal(connect.options.secure,true);assert.equal(connect.options.tls.rejectUnauthorized,true);assert.equal(connect.options.logger,false)
  assert.equal(lock.options.readOnly,true)
  assert.equal((await provider.disconnect()).connected,false)
})

test('IMAP traverses beyond 100 with a stable snapshot and Gmail API-compatible IDs',async()=>{
  const fake=fakeImap(),provider=createGmailProvider({root,credentials:memoryStore(),imapFactory:fake.factory})
  await provider.connectAppPassword({email:account,appPassword:password})
  const first=await provider.scanPage(),second=await provider.scanPage({cursor:first.nextCursor}),third=await provider.scanPage({cursor:second.nextCursor})
  assert.equal(first.messages.length,100);assert.equal(second.messages.length,100);assert.equal(third.messages.length,5)
  assert.equal(third.hasNextPage,false);assert.equal(first.mailboxEmail,account)
  assert.equal(first.messages[0].id,BigInt('100001').toString(16));assert.equal(first.messages[0].from.email,'alice@example.com')
  assert.equal(first.messages[0].internetMessageId,'<msg-1@example.com>')
  assert.equal(fake.calls.filter(call=>call.action==='fetch').some(call=>call.query.source),false)
})

test('IMAP reading one email downloads only a bounded text part and never the attachment or full source',async()=>{
  const fake=fakeImap(),provider=createGmailProvider({root,credentials:memoryStore(),imapFactory:fake.factory})
  await provider.connectAppPassword({email:account,appPassword:password})
  const result=await provider.getMessage(BigInt('100001').toString(16))
  assert.equal(result.text,'Actual message text');assert.equal(result.attachmentsOmitted,true);assert.equal(result.mailboxEmail,account)
  const query=fake.calls.find(call=>call.action==='fetchOne').query
  assert.equal(query.source,undefined);assert.equal(query.bodyStructure,true)
  const downloaded=fake.calls.find(call=>call.action==='download')
  assert.equal(downloaded.part,'1');assert.deepEqual(downloaded.options,{uid:true,maxBytes:1024*1024,chunkSize:64*1024})
  assert.equal(fake.calls.find(call=>call.action==='search').query.emailId,'100001')
})

test('sparse IMAP UIDs traverse actual messages once instead of scanning millions of empty ranges',async()=>{
  const fake=fakeImap({exists:3,uidNext:9000002,sparseUids:[1,5000000,9000001]}),provider=createGmailProvider({root,credentials:memoryStore(),imapFactory:fake.factory})
  await provider.connectAppPassword({email:account,appPassword:password})
  const result=await provider.scanPage()
  assert.equal(result.messages.length,3);assert.equal(result.hasNextPage,false)
  assert.equal(fake.calls.filter(call=>call.action==='search').length,1)
  assert.equal(fake.calls.find(call=>call.action==='fetch').range,'1,5000000,9000001')
})

test('invalid credentials fail before network and authentication diagnostics never echo secrets',async()=>{
  const fake=fakeImap({failConnect:true}),provider=createGmailProvider({root,credentials:memoryStore(),imapFactory:fake.factory})
  await assert.rejects(provider.connectAppPassword({email:'bad',appPassword:password}),{status:422})
  assert.equal(fake.calls.length,0)
  await assert.rejects(provider.connectAppPassword({email:account,appPassword:password}),error=>error.status===401&&!error.message.includes(password))
  assert.equal((await provider.status()).connected,false)
})

test('checkpoints cannot be resumed against a replaced Gmail account or arbitrary cursor',async()=>{
  const fake=fakeImap(),provider=createGmailProvider({root,credentials:memoryStore(),imapFactory:fake.factory})
  await provider.connectAppPassword({email:account,appPassword:password});const first=await provider.scanPage()
  await provider.connectAppPassword({email:'different@example.com',appPassword:password})
  await assert.rejects(provider.scanPage({cursor:first.nextCursor}),{code:'gmail_account_changed'})
  await assert.rejects(provider.scanPage({cursor:'../private'}),{code:'gmail_invalid_cursor'})
})

test('Google OAuth selects the first complete client pair and trims both values through code exchange',async t=>{
  const gmail={GMAIL_CLIENT_ID:'gmail-client',GMAIL_CLIENT_SECRET:'gmail-secret'},google={GOOGLE_CLIENT_ID:'google-client',GOOGLE_CLIENT_SECRET:'google-secret'},youtube={YOUTUBE_CLIENT_ID:'youtube-client',YOUTUBE_CLIENT_SECRET:'youtube-secret'}
  const scenarios=[
    {name:'Gmail takes priority over Google and YouTube',config:{...gmail,...google,...youtube},id:'gmail-client',secret:'gmail-secret'},
    {name:'Google takes priority over YouTube',config:{...google,...youtube},id:'google-client',secret:'google-secret'},
    {name:'a Gmail ID alone does not borrow a Google secret',config:{GMAIL_CLIENT_ID:'incomplete-gmail',...google},id:'google-client',secret:'google-secret'},
    {name:'a Gmail secret alone does not borrow a Google ID',config:{GMAIL_CLIENT_SECRET:'incomplete-secret',...google},id:'google-client',secret:'google-secret'},
    {name:'partial Gmail and Google pairs fall back to YouTube',config:{GMAIL_CLIENT_ID:'incomplete-gmail',GOOGLE_CLIENT_SECRET:'incomplete-google',...youtube},id:'youtube-client',secret:'youtube-secret'},
    {name:'complete pairs are trimmed before use',config:{GMAIL_CLIENT_ID:' \t gmail-client\n ',GMAIL_CLIENT_SECRET:' \n gmail-secret\t ',...google},id:'gmail-client',secret:'gmail-secret'},
    {name:'whitespace does not complete a higher-priority pair',config:{GMAIL_CLIENT_ID:'incomplete-gmail',GMAIL_CLIENT_SECRET:' \t ',GOOGLE_CLIENT_ID:' \n ',GOOGLE_CLIENT_SECRET:'incomplete-google',...youtube},id:'youtube-client',secret:'youtube-secret'},
  ]
  for(const scenario of scenarios)await t.test(scenario.name,async()=>{
    let exchanged=false
    const fetchImpl=async(url,options)=>{
      if(String(url)==='https://oauth2.googleapis.com/token'){
        assert.equal(options.body.get('client_id'),scenario.id);assert.equal(options.body.get('client_secret'),scenario.secret);exchanged=true
        return json({access_token:'synthetic-token',refresh_token:'synthetic-refresh',expires_in:3600,scope:'https://www.googleapis.com/auth/gmail.readonly'})
      }
      assert.equal(new URL(url).pathname,'/gmail/v1/users/me/profile');return json({emailAddress:account})
    }
    const provider=createGmailProvider({root,credentials:memoryStore(),fetchImpl,config:scenario.config})
    assert.equal((await provider.status()).oauthAvailable,true)
    const authorization=new URL((await provider.startOAuth()).authorizationUrl)
    assert.equal(authorization.searchParams.get('client_id'),scenario.id)
    await provider.finishOAuth(new URLSearchParams({state:authorization.searchParams.get('state'),code:'synthetic-code'}))
    assert.equal(exchanged,true)
  })
})

test('Google OAuth stays unavailable when only partial or whitespace client pairs exist',async t=>{
  for(const config of [{},{GMAIL_CLIENT_ID:'only-id',GOOGLE_CLIENT_SECRET:'unrelated-secret'},{GMAIL_CLIENT_ID:' \t ',GMAIL_CLIENT_SECRET:' \n ',YOUTUBE_CLIENT_ID:'only-youtube-id'}])await t.test(JSON.stringify(Object.keys(config)),async()=>{
    const provider=createGmailProvider({root,credentials:memoryStore(),config,fetchImpl:async()=>{throw Error('unconfigured OAuth must not contact Google')}})
    const status=await provider.status()
    assert.equal(status.oauthAvailable,false);assert.match(status.message,/host owner/);assert.match(status.message,/existing Spur Google OAuth registration can be reused/);assert.doesNotMatch(status.message,/app password|create.*app/i)
    await assert.rejects(provider.startOAuth(),error=>error.status===503&&error.code==='gmail_oauth_unconfigured'&&error.message===status.message)
  })
})

test('Google OAuth is readonly, uses PKCE, consumes state once, and keeps tokens out of API URLs/status',async()=>{
  const calls=[],credentials=memoryStore(),token='synthetic-access-token',refresh='synthetic-refresh-token'
  const fetchImpl=async(url,options)=>{
    calls.push({url:String(url),options})
    if(String(url)==='https://oauth2.googleapis.com/token')return json({access_token:token,refresh_token:refresh,expires_in:3600,scope:'https://www.googleapis.com/auth/gmail.readonly'})
    if(new URL(url).pathname.endsWith('/profile'))return json({emailAddress:account})
    throw Error('unexpected URL')
  }
  const provider=createGmailProvider({root,credentials,fetchImpl,config:{GMAIL_CLIENT_ID:'public-client-id',GMAIL_CLIENT_SECRET:'private-client-secret'}})
  const start=await provider.startOAuth(),authorization=new URL(start.authorizationUrl)
  assert.equal(authorization.hostname,'accounts.google.com');assert.equal(authorization.searchParams.get('scope'),'https://www.googleapis.com/auth/gmail.readonly');assert.equal(authorization.searchParams.get('code_challenge_method'),'S256')
  assert.equal(authorization.searchParams.get('redirect_uri'),'http://127.0.0.1:4173/api/email-memory/oauth/callback')
  assert.equal(start.authorizationUrl.includes('private-client-secret'),false)
  const params=new URLSearchParams({state:authorization.searchParams.get('state'),code:'synthetic-code'})
  const status=await finishGmailOAuth(params)
  assert.equal(status.email,account);assert.equal(status.method,'gmail_oauth');assert.equal(JSON.stringify(status).includes(token),false)
  assert.equal(calls.some(call=>call.url.includes(token)||call.url.includes(refresh)),false)
  assert.equal(calls.at(-1).options.headers.authorization,'Bearer '+token)
  await assert.rejects(finishGmailOAuth(params),{code:'gmail_invalid_state'})
})

test('Gmail API paginates actual message metadata, filters Spam/Trash and handles bodies without remote HTML',async()=>{
  const calls=[],credentials=memoryStore()
  await credentials.set({method:'gmail_oauth',email:account,accessToken:'synthetic-token',refreshToken:'synthetic-refresh',expiresAt:Date.now()+3600000,connectedAt:'fixed'})
  const fetchImpl=async(raw,options)=>{
    const url=new URL(raw);calls.push({url,options})
    if(url.pathname.endsWith('/messages'))return json(url.searchParams.get('pageToken')?{messages:[{id:'ab2'}],resultSizeEstimate:2}:{messages:[{id:'ab1'}],nextPageToken:'actual-cursor',resultSizeEstimate:2})
    const id=url.pathname.split('/').at(-1)
    return json({id,threadId:'cd1',internalDate:'1793520000000',sizeEstimate:400,labelIds:['INBOX'],payload:{mimeType:'text/plain',headers:[{name:'From',value:'Alice <alice@example.com>'},{name:'To',value:account},{name:'Subject',value:'Live-shaped message'}],...(url.searchParams.get('format')==='full'?{body:{data:Buffer.from('Read the actual plain text').toString('base64url')}}:{})}})
  }
  const provider=createGmailProvider({root,credentials,fetchImpl})
  const first=await provider.scanPage(),last=await provider.scanPage({cursor:first.nextCursor})
  assert.equal(first.messages[0].id,'ab1');assert.equal(last.messages[0].id,'ab2');assert.equal(last.hasNextPage,false)
  assert.equal(calls.find(call=>call.url.pathname.endsWith('/messages')).url.searchParams.get('includeSpamTrash'),'false')
  const opened=await provider.getMessage('ab1');assert.equal(opened.text,'Read the actual plain text');assert.equal(opened.from.email,'alice@example.com')
  assert.equal(calls.every(call=>call.url.hostname==='gmail.googleapis.com'),true)
})

test('Google auth/rate failures are safe and never mutate the previous connection',async()=>{
  const credentials=memoryStore();await credentials.set({method:'gmail_oauth',email:account,accessToken:'synthetic-token',expiresAt:Date.now()+3600000,connectedAt:'fixed'})
  const provider=createGmailProvider({root,credentials,fetchImpl:async()=>new Response(JSON.stringify({error:{message:password}}),{status:429})})
  await assert.rejects(provider.scanPage(),error=>error.status===429&&!error.message.includes(password))
  assert.equal((await provider.status()).connected,true)
})
