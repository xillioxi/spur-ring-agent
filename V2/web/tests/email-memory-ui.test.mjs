import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {fileURLToPath} from 'node:url'

const bundled=await build({entryPoints:[fileURLToPath(new URL('../src/emailMemoryApi.ts',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',target:'es2020'})
const api=await import('data:text/javascript;base64,'+Buffer.from(bundled.outputFiles[0].text).toString('base64'))
const uiBundled=await build({stdin:{contents:"export {MemoryPage,SocialAccountOptions} from './src/MemoryPage.tsx'; export {EmailConnectionPanel,EmailMailboxSwitcher} from './src/EmailMemoryWorkspace.tsx'; export {EmailMemoryModal} from './src/EmailMemoryModal.tsx'; export {ConnectedApps} from './src/ConnectedApps.tsx'; export {renderToStaticMarkup} from 'react-dom/server.browser'",resolveDir:fileURLToPath(new URL('..',import.meta.url)),loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser',target:'es2020',loader:{'.css':'empty'},define:{'process.env.NODE_ENV':'"production"'}})
const ui=await import('data:text/javascript;base64,'+Buffer.from(uiBundled.outputFiles[0].text).toString('base64'))
const prefix='/api/creator-agent/email-memory'
const response=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}})
const originalFetch=globalThis.fetch

test('Memory opens the centralized bank first, with Social network kept as a separate workspace',()=>{
  const markup=ui.renderToStaticMarkup({$$typeof:Symbol.for('react.element'),type:ui.MemoryPage,key:null,ref:null,props:{},_owner:null})
  assert.match(markup,/Memory bank/);assert.match(markup,/Social network/);assert.match(markup,/YOUR CENTRAL MEMORY BANK/);assert.match(markup,/About me/);assert.match(markup,/Knowledge/);assert.match(markup,/Add memory/);assert.doesNotMatch(markup,/Illustrative examples/)
  assert.match(markup,/Opening your memory bank/)
  assert.doesNotMatch(markup,/Your email accounts will appear here/)
  assert.doesNotMatch(markup,/Studio Lumière|Paris Travel Film|jack@example.com|example profile updated/)
})

test('Gmail connection sends credentials only in the private POST body and normalizes app-password spaces',async t=>{
  t.after(()=>{globalThis.fetch=originalFetch})
  const calls=[]
  globalThis.fetch=async(url,options)=>{calls.push({url,options});return response({connection:{connected:true,email:'owner@gmail.com'}})}
  const result=await api.connectGmailAppPassword(' owner@gmail.com ','abcd efgh ijkl mnop')
  assert.equal(result.connection.connected,true)
  assert.equal(calls[0].url,prefix+'/connect');assert.equal(calls[0].options.method,'POST')
  assert.deepEqual(JSON.parse(calls[0].options.body),{email:'owner@gmail.com',appPassword:'abcdefghijklmnop'})
  assert.equal(calls[0].url.includes('abcdefghijklmnop'),false)
  assert.equal(calls[0].options.headers.Authorization,undefined)
  assert.equal(calls[0].options.cache,'no-store')
})

test('metadata search, person filter and message pagination stay in the scoped mailbox API',async t=>{
  t.after(()=>{globalThis.fetch=originalFetch})
  const calls=[]
  globalThis.fetch=async(url,options)=>{calls.push({url,options});return response(url.includes('/graph')?{nodes:[],edges:[]}:{messages:[],hasMore:false,total:0})}
  await api.getEmailNetwork('Alex + team')
  await api.getEmailMemoryMessages({person:'alex+work@example.com',query:'production plan',cursor:'50',limit:50})
  const graph=new URL(calls[0].url,'http://localhost'),mail=new URL(calls[1].url,'http://localhost')
  assert.equal(graph.searchParams.get('query'),'Alex + team')
  assert.equal(mail.searchParams.get('person'),'alex+work@example.com');assert.equal(mail.searchParams.get('query'),'production plan');assert.equal(mail.searchParams.get('cursor'),'50')
})

test('message opening encodes identifiers and leaves HTML as text data instead of rendering markup',async t=>{
  t.after(()=>{globalThis.fetch=originalFetch})
  const calls=[]
  globalThis.fetch=async(url)=>{calls.push(url);return response({message:{id:'imap:123/456',text:'<script>source text</script>'}})}
  const result=await api.getEmailMemoryMessage('imap:123/456')
  assert.equal(calls[0],prefix+'/messages/imap%3A123%2F456')
  assert.equal(result.message.text,'<script>source text</script>')
})

test('sync returns an asynchronous status receipt, and disconnect preserves the local data boundary',async t=>{
  t.after(()=>{globalThis.fetch=originalFetch})
  const calls=[]
  globalThis.fetch=async(url,options)=>{calls.push({url,options});return response({status:{sync:{status:'running'}}})}
  const result=await api.syncEmailMemory(true);await api.disconnectGmailMemory()
  assert.equal(result.status.sync.status,'running');assert.deepEqual(JSON.parse(calls[0].options.body),{resume:true})
  assert.equal(calls[1].url,prefix+'/connection');assert.equal(calls[1].options.method,'DELETE')
})

test('mailbox errors do not become success, and requests remain cancellable during body reads',async t=>{
  t.after(()=>{globalThis.fetch=originalFetch})
  globalThis.fetch=async()=>new Response(JSON.stringify({error:'Reconnect your Gmail account.'}),{status:401,headers:{'content-type':'application/json'}})
  await assert.rejects(api.getEmailMemoryStatus(),/Reconnect your Gmail account/)
  let signal
  globalThis.fetch=async(_url,options)=>{signal=options.signal;return {ok:true,json:()=>new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}))}}
  const controller=new AbortController(),pending=api.getEmailMemoryStatus(controller.signal)
  await Promise.resolve();controller.abort()
  await assert.rejects(pending,/cancelled/);assert.equal(signal.aborted,true)
})

test('OAuth authorization only opens the official Google host',()=>{
  assert.equal(api.gmailAuthorizationUrl('https://accounts.google.com/o/oauth2/v2/auth?state=synthetic'),'https://accounts.google.com/o/oauth2/v2/auth?state=synthetic')
  for(const value of ['https://accounts.google.com.attacker.test/oauth','http://accounts.google.com/oauth','https://user:secret@accounts.google.com/oauth','javascript:alert(1)','https://attacker.test/oauth'])assert.equal(api.gmailAuthorizationUrl(value),undefined)
})

test('provider-specific connection requests preserve non-Gmail secrets and force secure IMAP settings',async t=>{
  t.after(()=>{globalThis.fetch=originalFetch})
  const calls=[]
  globalThis.fetch=async(url,options)=>{calls.push({url,options});return response({connection:{connected:true}})}
  await api.connectEmailMailbox({provider:'zoho',email:' owner@company.test ',appPassword:'opaque secret  with spaces ',region:'eu',accountType:'business'})
  await api.connectEmailMailbox({provider:'imap',email:'owner@company.test',appPassword:' exact password ',host:' IMAP.EXAMPLE.TEST ',port:143})
  await api.connectEmailMailbox({provider:'gmail',email:'owner@gmail.com',appPassword:'abcd efgh ijkl mnop'})
  const [zoho,imap,gmail]=calls.map(call=>JSON.parse(call.options.body))
  assert.deepEqual(zoho,{provider:'zoho',email:'owner@company.test',appPassword:'opaque secret  with spaces ',region:'eu',accountType:'business'})
  assert.deepEqual(imap,{provider:'imap',email:'owner@company.test',appPassword:' exact password ',host:'imap.example.test',port:993})
  assert.equal(gmail.appPassword,'abcdefghijklmnop')
  for(const call of calls){assert.equal(call.url,prefix+'/connect');assert.equal(call.options.method,'POST');assert.equal(call.url.includes('password'),false)}
})

test('Microsoft OAuth sends only the provider and optional public application ID in a POST',async t=>{
  t.after(()=>{globalThis.fetch=originalFetch})
  const calls=[]
  globalThis.fetch=async(url,options)=>{calls.push({url,options});return response({authorizationUrl:'https://login.microsoftonline.com/common/oauth2/v2.0/authorize'})}
  await api.startEmailOAuth('outlook',' 12345678-1234-1234-1234-123456789abc ')
  assert.deepEqual(JSON.parse(calls[0].options.body),{provider:'outlook',clientId:'12345678-1234-1234-1234-123456789abc'})
  assert.equal(calls[0].url,prefix+'/oauth/start')
  assert.equal(api.emailAuthorizationUrl('https://login.microsoftonline.com/common/oauth2/v2.0/authorize','outlook'),'https://login.microsoftonline.com/common/oauth2/v2.0/authorize')
  for(const url of ['https://login.microsoftonline.com.attacker.test/oauth','http://login.microsoftonline.com/oauth','https://user:secret@login.microsoftonline.com/oauth','https://accounts.google.com/oauth'])assert.equal(api.emailAuthorizationUrl(url,'outlook'),undefined)
})

const element=(type,props)=>({$$typeof:Symbol.for('react.element'),type,key:null,ref:null,props,_owner:null})
const connectionMarkup=(provider,oauthAvailable=false,busy='')=>ui.renderToStaticMarkup(element(ui.EmailConnectionPanel,{connection:{connected:false,provider,providers:[{id:provider,label:provider,oauthAvailable}]},busy,syncing:false,error:'',authorizationUrl:'',onClose(){},onConnect:async()=>{},onAuthorize:async()=>{},onDisconnect:async()=>{},onCheck(){},onProviderChange(){}}))

for(const oauthAvailable of [false,true])test(`Gmail keeps Google sign-in primary with ${oauthAvailable?'configured':'unconfigured'} host OAuth and a collapsed app-password fallback`,()=>{
  const markup=connectionMarkup('gmail',oauthAvailable)
  const button=markup.match(/<button\b[^>]*class="email-memory-primary"[^>]*>Sign in with Google ↗<\/button>/)?.[0]
  assert.ok(button)
  assert.equal(button.includes('disabled=""'),!oauthAvailable)
  assert.ok(markup.indexOf(button)<markup.indexOf('<details'))
  const fallback=markup.match(/<details([^>]*)><summary>Use an app password instead<\/summary>([\s\S]*?)<\/details>/)
  assert.ok(fallback)
  assert.doesNotMatch(fallback[1],/\bopen\b/)
  assert.match(fallback[2],/<form\b/);assert.match(fallback[2],/Google app password/);assert.match(fallback[2],/type="password"/)
  assert.equal((markup.match(/type="password"/g)||[]).length,1)
  if(oauthAvailable)assert.match(markup,/Grant read-only Gmail access in Google’s own sign-in window/)
  else assert.match(markup,/Google sign-in has not been configured for this Spur installation\. The Spur owner can reuse an existing Google app registration; each mailbox only needs to sign in and approve access\./)
  assert.doesNotMatch(markup,/create (?:a )?(?:new )?Google (?:Cloud )?app|client secret|OAuth client|Connected to/i)
})

test('Gmail Google sign-in is disabled while a connection action is busy',()=>{
  assert.match(connectionMarkup('gmail',true,'connect'),/<button\b[^>]*class="email-memory-primary"[^>]*disabled=""[^>]*>Sign in with Google ↗<\/button>/)
})

test('Outlook uses Microsoft authorization with public app setup and has no password fallback',()=>{
  const markup=connectionMarkup('outlook')
  assert.match(markup,/Outlook &amp; Microsoft 365/);assert.match(markup,/Sign in with Microsoft/)
  assert.match(markup,/Microsoft application ID/);assert.match(markup,/No client secret is needed/)
  assert.match(markup,/api\/email-memory\/outlook\/callback/)
  assert.doesNotMatch(markup,/type="password"|Google app password|Mailbox or app password/)
})

test('Zoho offers only supported regions and account types with its own application-password guidance',()=>{
  const markup=connectionMarkup('zoho')
  assert.match(markup,/Zoho data centre/);assert.match(markup,/Auto-detect from email/);assert.match(markup,/Paid organization \/ custom domain/);assert.match(markup,/Personal \/ free organization/)
  assert.match(markup,/United States/);assert.match(markup,/Europe/);assert.match(markup,/India/);assert.match(markup,/Australia/);assert.match(markup,/Japan/)
  assert.match(markup,/China/)
  assert.match(markup,/Zoho mail or app password/);assert.match(markup,/zoho.com\/mail\/help\/imap-access.html/)
  assert.match(markup,/Incoming server/);assert.match(markup,/imappro.zoho.com · 993 · TLS/);assert.match(markup,/12-character Zoho application-specific password/)
  assert.doesNotMatch(markup,/Saudi|Canada|type="checkbox"/)
})

test('generic IMAP form requires its server and has a fixed TLS port with no insecure option',()=>{
  const markup=connectionMarkup('imap')
  assert.match(markup,/IMAP server/);assert.match(markup,/Secure IMAP port/);assert.match(markup,/993 · TLS/)
  assert.match(markup,/readonly=""/);assert.doesNotMatch(markup,/Disable TLS|Skip verification|SSL off/)
})

test('Add accounts and Connections share the same icon options and direct setup routes',()=>{
  const connections=ui.renderToStaticMarkup(element(ui.ConnectedApps,{signedIn:false,ready:true,youtube:null,busy:false,error:'',onConnect(){},onDisconnect(){},onRefresh(){},onNeedLogin(){}}))
  const picker=ui.renderToStaticMarkup(element(ui.SocialAccountOptions,{onChoose(){}}))
  for(const [id,label] of [['gmail','Gmail'],['outlook','Outlook &amp; Microsoft 365'],['zoho','Zoho Mail'],['imap','Other email (IMAP)'],['whatsapp','WhatsApp'],['instagram','Instagram'],['messenger','Messenger']]){
    assert.ok(connections.includes(`href="#memory/${id}"`))
    for(const markup of [connections,picker]){
      assert.ok(markup.includes(`is-${id}" aria-hidden="true"`))
      assert.ok(markup.includes(`<strong>${label}</strong>`))
    }
  }
  assert.ok(connections.includes('href="#memory/social"'))
  assert.equal((picker.match(/<button /g)||[]).length,7)
})

test('opening setup from a provider tile overrides the selected mailbox provider',()=>{
  const markup=ui.renderToStaticMarkup(element(ui.EmailConnectionPanel,{mode:'add',initialProvider:'zoho',connection:{connected:true,provider:'gmail',email:'existing@example.test'},busy:'',syncing:false,error:'',authorizationUrl:'',onClose(){},onConnect:async()=>{},onAuthorize:async()=>{},onDisconnect:async()=>{},onCheck(){},onProviderChange(){}}))
  assert.match(markup,/<option value="zoho" selected="">Zoho Mail<\/option>/)
  assert.match(markup,/Zoho data centre/)
})

test('mailbox selection sends only the saved slot ID and returns its full private status',async t=>{
  t.after(()=>{globalThis.fetch=originalFetch})
  let call
  globalThis.fetch=async(url,options)=>{call={url,options};return response({status:{connection:{connected:true,selectedMailboxId:'mailbox-two'},messageCount:23}})}
  const result=await api.selectEmailMailbox('mailbox-two')
  assert.equal(call.url,prefix+'/mailboxes/select');assert.equal(call.options.method,'POST')
  assert.deepEqual(JSON.parse(call.options.body),{mailboxId:'mailbox-two'})
  assert.equal(result.status.connection.selectedMailboxId,'mailbox-two')
})

test('topbar shows multiple mailboxes including accounts from the same provider without invented chips',()=>{
  const mailboxes=[{id:'one',provider:'gmail',providerLabel:'Gmail',email:'one@example.test',accountId:'gmail-one',connected:true},{id:'two',provider:'gmail',providerLabel:'Gmail',email:'two@example.test',accountId:'gmail-two',connected:true},{id:'three',provider:'zoho',providerLabel:'Zoho Mail',email:'three@example.test',accountId:'zoho-three',connected:false}]
  const markup=ui.renderToStaticMarkup(element(ui.EmailMailboxSwitcher,{mailboxes,selectedMailboxId:'two',selecting:false,adding:false,onSelect(){},onAdd(){}}))
  assert.match(markup,/Email accounts/);assert.match(markup,/one@example.test/);assert.match(markup,/two@example.test/);assert.match(markup,/three@example.test/)
  assert.equal((markup.match(/aria-pressed="true"/g)||[]).length,1)
  assert.match(markup,/Zoho Mail · reconnect/);assert.match(markup,/Add accounts/)
  const empty=ui.renderToStaticMarkup(element(ui.EmailMailboxSwitcher,{mailboxes:[],selecting:false,adding:false,onSelect(){},onAdd(){}}))
  assert.match(empty,/Your email accounts will appear here/);assert.doesNotMatch(empty,/@example|is-gmail|Unassigned/)
})

test('adding a mailbox keeps the provider dropdown available while another account stays connected',()=>{
  const markup=ui.renderToStaticMarkup(element(ui.EmailConnectionPanel,{mode:'add',connection:{connected:true,provider:'gmail',email:'already-connected@example.test'},busy:'',syncing:false,error:'',authorizationUrl:'',onClose(){},onConnect:async()=>{},onAuthorize:async()=>{},onDisconnect:async()=>{},onCheck(){},onProviderChange(){}}))
  assert.match(markup,/Add email account/);assert.match(markup,/Email provider/);assert.match(markup,/Outlook &amp; Microsoft 365/)
  assert.match(markup,/aria-label="Email provider"/)
  assert.match(markup,/Zoho Mail/);assert.match(markup,/Other email \(IMAP\)/)
  assert.doesNotMatch(markup,/value="already-connected@example.test"|Disconnect this mailbox/)
})

test('sync labels never describe a bounded, failed or interrupted import as complete',()=>{
  for(const status of ['idle','running','partial','blocked','failed'])assert.equal(api.emailSyncPresentation({status,resumable:true}).complete,false)
  assert.equal(api.emailSyncPresentation({status:'complete'}).complete,true)
  assert.equal(api.emailSyncPresentation({status:'partial',resumable:true}).action,'Resume sync')
  assert.equal(api.emailSyncPresentation({status:'running'}).running,true)
})

test('loading more messages deduplicates stable mailbox IDs and keeps the latest metadata',()=>{
  assert.deepEqual(api.mergeEmailMessages([{id:'one',subject:'old'}],[{id:'one',subject:'fresh'},{id:'two',subject:'second'}]),[{id:'one',subject:'fresh'},{id:'two',subject:'second'}])
})

test('mailbox identity separates identical email addresses across providers and IMAP servers',()=>{
  const gmail={connected:true,email:'owner@company.test',provider:'gmail',accountId:'gmail:owner-namespace'}
  const outlook={connected:true,email:'owner@company.test',provider:'outlook',accountId:'outlook:owner-namespace'}
  const oldHost={connected:true,email:'owner@company.test',provider:'imap',accountId:'imap:server-one'}
  const newHost={connected:true,email:'owner@company.test',provider:'imap',accountId:'imap:server-two'}
  const keys=[gmail,outlook,oldHost,newHost].map(connection=>api.emailMailboxIdentity(connection))
  assert.equal(new Set(keys).size,4)
  assert.equal(api.emailResponseMatchesMailbox(keys[3],{accountId:keys[2]}),false)
  assert.equal(api.emailResponseMatchesMailbox(keys[1],{accountId:keys[0]}),false)
  assert.equal(api.emailResponseMatchesMailbox(keys[3],{accountId:keys[3]}),true)
  assert.equal(api.emailMailboxIdentity({connected:true,provider:'zoho',email:'Owner@Company.test'}),'zoho:owner@company.test')
  assert.equal(api.emailMailboxIdentity(undefined),'')
  const disconnected=api.emailMailboxIdentity({connected:false,provider:'imap'},'owner@company.test','imap:server-one')
  assert.equal(disconnected,'imap:server-one')
  assert.equal(api.emailResponseMatchesMailbox(disconnected,{accountId:'imap:server-one'}),true)
  assert.equal(api.emailMailboxIdentity(outlook,'owner@company.test','old-cached-mailbox'),outlook.accountId)
  assert.equal(api.emailResponseMatchesMailbox('',{accountId:null}),true)
  assert.equal(api.emailResponseMatchesMailbox(keys[0],{accountId:null}),false)
})

test('Zoho auto mode chooses a branded personal mailbox without changing the explicitly selected data centre',()=>{
  assert.deepEqual(api.zohoServerPreview({email:' Owner@Zoho.com '}),{host:'imap.zoho.com',accountType:'personal',automatic:true})
  assert.equal(api.zohoServerPreview({email:'owner@zohomail.com',region:'eu'}).host,'imap.zoho.eu')
  assert.equal(api.zohoServerPreview({email:'owner@zoho.eu',region:'us'}).host,'imap.zoho.com')
  assert.equal(api.zohoServerPreview({email:'owner@company.test'}).host,'imappro.zoho.com')
  assert.equal(api.zohoServerPreview({email:'owner@company.test',accountType:'personal'}).host,'imap.zoho.com')
  assert.equal(api.zohoServerPreview({email:'owner@zoho.com',accountType:'business'}).host,'imappro.zoho.com')
  assert.equal(api.zohoServerPreview({email:'owner@zoho.com',region:'__proto__'}),undefined)
})

test('Zoho connection defaults to auto account type while preserving non-secret configuration and the exact password',async t=>{
  t.after(()=>{globalThis.fetch=originalFetch})
  let body
  globalThis.fetch=async(_url,options)=>{body=JSON.parse(options.body);return response({connection:{connected:true}})}
  await api.connectEmailMailbox({provider:'zoho',email:' owner@zoho.com ',appPassword:'zoho exact secret ',region:'eu'})
  assert.deepEqual(body,{provider:'zoho',email:'owner@zoho.com',appPassword:'zoho exact secret ',region:'eu',accountType:'auto'})
})

test('sanitized provider errors keep their actionable code and visible message',async t=>{
  t.after(()=>{globalThis.fetch=originalFetch})
  globalThis.fetch=async()=>new Response(JSON.stringify({error:'Zoho requires an application-specific password.',code:'zoho_app_password_required'}),{status:401,headers:{'content-type':'application/json'}})
  await assert.rejects(api.connectEmailMailbox({provider:'zoho',email:'owner@zoho.com',appPassword:'synthetic-secret'}),error=>error instanceof api.EmailMemoryApiError&&error.code==='zoho_app_password_required'&&error.status===401&&error.message==='Zoho requires an application-specific password.')
  assert.match(api.zohoConnectionGuidance('zoho_app_password_required'),/12-character Zoho/)
  assert.match(api.zohoConnectionGuidance('zoho_imap_disabled'),/Enable IMAP/)
  assert.match(api.zohoConnectionGuidance('imap_tls_failed'),/securely/)
})

test('Zoho form displays the resolved server and password-specific guidance without exposing credentials',()=>{
  const markup=ui.renderToStaticMarkup(element(ui.EmailConnectionPanel,{mode:'add',connection:{connected:false,provider:'zoho'},busy:'',syncing:false,error:'Zoho requires an application-specific password.',errorCode:'zoho_app_password_required',authorizationUrl:'',onClose(){},onConnect:async()=>{},onAuthorize:async()=>{},onDisconnect:async()=>{},onCheck(){},onProviderChange(){}}))
  assert.match(markup,/Zoho requires an application-specific password/)
  assert.match(markup,/12-character Zoho application-specific password/)
  assert.match(markup,/Open Zoho IMAP settings guide/)
  assert.match(markup,/aria-label="Zoho incoming server"/)
  assert.doesNotMatch(markup,/synthetic-secret|Your 16-character app password/)
})

test('Add email account is presented in a labelled modal popup containing the provider dropdown',()=>{
  const panel=element(ui.EmailConnectionPanel,{mode:'add',connection:{connected:false,provider:'zoho'},busy:'',syncing:false,error:'',authorizationUrl:'',onClose(){},onConnect:async()=>{},onAuthorize:async()=>{},onDisconnect:async()=>{},onCheck(){},onProviderChange(){}})
  const markup=ui.renderToStaticMarkup(element(ui.EmailMemoryModal,{title:'Add email account',busy:false,onClose(){},children:panel}))
  assert.match(markup,/role="dialog"/);assert.match(markup,/aria-modal="true"/);assert.match(markup,/aria-label="Add email account"/)
  assert.match(markup,/email-memory-modal-layer/);assert.match(markup,/email-memory-modal-backdrop/)
  assert.match(markup,/aria-label="Email provider"/);assert.match(markup,/aria-label="Close email connection"/)
  assert.match(markup,/Zoho incoming server/);assert.match(markup,/12-character Zoho application-specific password/)
  assert.doesNotMatch(markup,/detail-drawer/)
})

test('popup cannot be closed while a mailbox credential is being verified',()=>{
  const panel=element(ui.EmailConnectionPanel,{mode:'add',connection:{connected:false,provider:'zoho'},busy:'connect',syncing:false,error:'',authorizationUrl:'',onClose(){},onConnect:async()=>{},onAuthorize:async()=>{},onDisconnect:async()=>{},onCheck(){},onProviderChange(){}})
  const markup=ui.renderToStaticMarkup(element(ui.EmailMemoryModal,{title:'Add email account',busy:true,onClose(){},children:panel}))
  assert.match(markup,/aria-busy="true"/)
  assert.match(markup,/aria-label="Close account popup" disabled=""/)
  assert.match(markup,/aria-label="Close email connection" disabled=""/)
})
