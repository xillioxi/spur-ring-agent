import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises'
import {join,resolve,relative,isAbsolute} from 'node:path'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {createCredentialStore} from './email-memory/credential-store.mjs'
import {validateGoogleOAuthWebClient,importGoogleOAuthClient,loadGoogleOAuthConfig} from './google-oauth-client.mjs'

const CALLBACK='http://127.0.0.1:4173/api/email-memory/oauth/callback'
const clientId='123456789-synthetic.apps.googleusercontent.com',clientSecret='GOCSPX-synthetic-private-secret'
const document=()=>({web:{client_id:clientId,client_secret:clientSecret,redirect_uris:[CALLBACK,'https://example.test/previous-callback'],auth_uri:'https://accounts.google.com/o/oauth2/auth',token_uri:'https://oauth2.googleapis.com/token',project_id:'synthetic-project'}})
function memoryStore(storage='os_protected'){
  let value=null
  return {storage,async get(){return value?structuredClone(value):null},async set(next){value=structuredClone(next)}}
}
async function fixture(t){
  const root=await mkdtemp(join(process.cwd(),'.google-oauth-client-test-'))
  t.after(async()=>{const part=relative(resolve(process.cwd()),resolve(root));assert.ok(part&&!part.startsWith('..')&&!isAbsolute(part));await rm(root,{recursive:true,force:true})})
  return root
}
const protect=async value=>Buffer.from(value).toString('base64'),unprotect=async value=>Buffer.from(value,'base64').toString('utf8')

test('valid Google web downloads need no scope fields and return only the application credential pair',()=>{
  assert.deepEqual(validateGoogleOAuthWebClient(document()),{clientId,clientSecret})
  const value=document();value.web.auth_uri='https://accounts.google.com/o/oauth2/v2/auth'
  assert.deepEqual(validateGoogleOAuthWebClient(JSON.stringify(value)),{clientId,clientSecret})
})

test('validation rejects installed clients, unsafe Google endpoints, invalid pairs and missing callbacks without echoing input',async t=>{
  const invalidDocuments=[
    {installed:document().web},{...document(),installed:{}},null,[],{web:[]},
    ...['https://accounts.google.com.evil.test/o/oauth2/auth','http://accounts.google.com/o/oauth2/auth','https://accounts.google.com@evil.test/o/oauth2/auth','https://accounts.google.com/o/oauth2/auth?secret='+clientSecret].map(auth_uri=>({web:{...document().web,auth_uri}})),
    ...['https://oauth2.googleapis.com.evil.test/token','https://evil.test/token','http://oauth2.googleapis.com/token','https://oauth2.googleapis.com/token#fragment'].map(token_uri=>({web:{...document().web,token_uri}})),
    ...['bad-client',clientId+'.evil.test',' '+clientId,'a'.repeat(301)+'.apps.googleusercontent.com'].map(client_id=>({web:{...document().web,client_id}})),
    ...['',' ',clientSecret+'\n',clientSecret+'\0','a'.repeat(1001)].map(client_secret=>({web:{...document().web,client_secret}})),
    {web:{...document().web,redirect_uris:['http://localhost:4173/api/email-memory/oauth/callback']}},
    {web:{...document().web,redirect_uris:[CALLBACK+'?extra=true']}},
    {web:{...document().web,redirect_uris:[CALLBACK,'javascript:alert(1)']}},
    {web:{...document().web,redirect_uris:[CALLBACK,'https://user:password@example.test/callback']}},
    {web:{...document().web,redirect_uris:[...Array(33)].fill(CALLBACK)}},
    {web:{...document().web,extra:'a'.repeat(65536)}},'a'.repeat(65537),'{"private":"'+clientSecret+'"',
  ]
  for(const [index,value]of invalidDocuments.entries())await t.test(String(index+1),()=>{
    assert.throws(()=>validateGoogleOAuthWebClient(value),error=>error.code==='google_oauth_client_invalid'&&!error.message.includes(clientSecret)&&!error.message.includes(clientId)&&!error.message.includes('evil.test'))
  })
})

test('import persists protected app credentials in a separate store and exposes success metadata only',async t=>{
  const runtimeRoot=await fixture(t),root=join(runtimeRoot,'google-oauth-client')
  const credentials=createCredentialStore({root,protect,unprotect})
  const result=await importGoogleOAuthClient({runtimeRoot,document:document(),credentials})
  assert.deepEqual(result,{configured:true,callback:CALLBACK,storage:'os_protected'})
  assert.equal(JSON.stringify(result).includes(clientSecret),false);assert.equal(JSON.stringify(result).includes(clientId),false)
  const stored=await readFile(join(root,'private-connections','gmail.dpapi'),'utf8')
  assert.equal(stored.includes(clientSecret),false)
  const reopened=createCredentialStore({root,protect,unprotect})
  assert.deepEqual(await loadGoogleOAuthConfig({runtimeRoot,credentials:reopened,config:{OTHER_SETTING:'unchanged'}}),{OTHER_SETTING:'unchanged',GMAIL_CLIENT_ID:clientId,GMAIL_CLIENT_SECRET:clientSecret})
  await assert.rejects(readFile(join(runtimeRoot,'private-connections','gmail.dpapi')),{code:'ENOENT'})
})

test('each complete explicit pair takes precedence without opening storage or changing the original config',async t=>{
  for(const prefix of ['GMAIL','GOOGLE','YOUTUBE'])await t.test(prefix,async()=>{
    const config={GMAIL_CLIENT_ID:'partial-gmail',GOOGLE_CLIENT_SECRET:'partial-google',[`${prefix}_CLIENT_ID`]:' explicit-id ',[`${prefix}_CLIENT_SECRET`]:' explicit-secret '}
    const credentials={async get(){throw Error('must not read stored app credentials')}}
    assert.equal(await loadGoogleOAuthConfig({config,credentials}),config)
  })
})

test('partial and whitespace explicit pairs cannot mix with each other or the saved Google application',async()=>{
  const credentials=memoryStore();await importGoogleOAuthClient({document:document(),credentials})
  const config={GMAIL_CLIENT_ID:'unrelated-id',GMAIL_CLIENT_SECRET:' \t ',GOOGLE_CLIENT_SECRET:'unrelated-secret',YOUTUBE_CLIENT_ID:' \n ',YOUTUBE_CLIENT_SECRET:'another-secret'}
  const result=await loadGoogleOAuthConfig({config,credentials})
  assert.equal(result.GMAIL_CLIENT_ID,clientId);assert.equal(result.GMAIL_CLIENT_SECRET,clientSecret)
  assert.equal(result.GOOGLE_CLIENT_SECRET,config.GOOGLE_CLIENT_SECRET);assert.equal(config.GMAIL_CLIENT_ID,'unrelated-id')
  const empty={GMAIL_CLIENT_ID:'partial-only'}
  assert.equal(await loadGoogleOAuthConfig({config:empty,credentials:memoryStore()}),empty)
})

test('storage errors and malformed saved data return static errors without raw credential values',async()=>{
  const rejects=error=>error.code==='google_oauth_client_storage_unavailable'&&!error.message.includes(clientSecret)
  await assert.rejects(importGoogleOAuthClient({document:document(),credentials:{async set(){throw Error(clientSecret)}}}),rejects)
  await assert.rejects(loadGoogleOAuthConfig({credentials:{async get(){throw Error(clientSecret)}}}),rejects)
  await assert.rejects(loadGoogleOAuthConfig({credentials:{async get(){return {schemaVersion:1,clientId,clientSecret,callback:'https://evil.test'}}}}),rejects)
})

test('ordinary module imports do not run the CLI or read an argument file',()=>{
  const moduleUrl=new URL('./google-oauth-client.mjs',import.meta.url).href
  const source=`process.argv.push('import','must-not-read.json','must-not-write'); await import(${JSON.stringify(moduleUrl)});`
  const result=spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8',windowsHide:true})
  assert.equal(result.status,0);assert.equal(result.stdout,'');assert.equal(result.stderr,'')
})

test('CLI rejects session-only persistence before reading or saving a downloaded file',()=>{
  const moduleUrl=new URL('./google-oauth-client.mjs',import.meta.url).href
  const source=`Object.defineProperty(process,'platform',{value:'linux'});process.argv=[process.execPath,${JSON.stringify(fileURLToPath(moduleUrl))},'import','must-not-read.json','must-not-write'];await import(${JSON.stringify(moduleUrl)});`
  const result=spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8',windowsHide:true})
  assert.equal(result.status,1);assert.equal(result.stdout,'');assert.match(result.stderr,/cannot persist protected OAuth clients/);assert.match(result.stderr,/GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET/)
})

test('CLI rejects oversized or malformed synthetic download files without echoing their contents',async t=>{
  const root=await fixture(t),moduleUrl=new URL('./google-oauth-client.mjs',import.meta.url).href
  for(const [name,value]of [['oversized.json',clientSecret+'a'.repeat(65536)],['malformed.json','{"secret":"'+clientSecret+'"']]){
    const file=join(root,name);await writeFile(file,value)
    const source=`Object.defineProperty(process,'platform',{value:'win32'});process.argv=[process.execPath,${JSON.stringify(fileURLToPath(moduleUrl))},'import',${JSON.stringify(file)},${JSON.stringify(root)}];await import(${JSON.stringify(moduleUrl)});`
    const result=spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8',windowsHide:true})
    assert.equal(result.status,1);assert.equal(result.stdout,'');assert.match(result.stderr,/valid Google OAuth web client JSON/);assert.equal(result.stderr.includes(clientSecret),false)
  }
})
