import {open} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {createCredentialStore} from './email-memory/credential-store.mjs'

const CALLBACK='http://127.0.0.1:4173/api/email-memory/oauth/callback'
const MAX_DOCUMENT_BYTES=64*1024
const AUTH_URIS=new Set(['https://accounts.google.com/o/oauth2/auth','https://accounts.google.com/o/oauth2/v2/auth'])
const TOKEN_URI='https://oauth2.googleapis.com/token'
const fail=(message,status=422,code='google_oauth_client_invalid')=>Object.assign(new Error(message),{status,code})
const invalid=()=>fail('Import a valid Google OAuth web client JSON with the local Spur Gmail callback registered.')
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)
const safeString=(value,max)=>typeof value==='string'&&value.length<=max&&/^[\x21-\x7e]+$/.test(value)
const validPair=(clientId,clientSecret)=>safeString(clientId,300)&&/^[A-Za-z0-9][A-Za-z0-9_-]*\.apps\.googleusercontent\.com$/.test(clientId)&&safeString(clientSecret,1000)

/** Validate Google's downloaded web-client document; no account tokens are accepted. */
export function validateGoogleOAuthWebClient(document){
  let value=document
  try{
    const serialized=typeof document==='string'?document:JSON.stringify(document)
    if(typeof serialized!=='string'||Buffer.byteLength(serialized)>MAX_DOCUMENT_BYTES)throw invalid()
    value=JSON.parse(serialized)
  }catch{throw invalid()}
  if(!object(value)||Object.hasOwn(value,'installed')||!object(value.web))throw invalid()
  const web=value.web
  if(!validPair(web.client_id,web.client_secret)||!AUTH_URIS.has(web.auth_uri)||web.token_uri!==TOKEN_URI)throw invalid()
  if(!Array.isArray(web.redirect_uris)||web.redirect_uris.length>32||!web.redirect_uris.includes(CALLBACK))throw invalid()
  for(const uri of web.redirect_uris){
    if(!safeString(uri,2048))throw invalid()
    let parsed;try{parsed=new URL(uri)}catch{throw invalid()}
    if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password||parsed.hash)throw invalid()
  }
  return {clientId:web.client_id,clientSecret:web.client_secret}
}

function clientStore({runtimeRoot,credentials}){
  if(credentials)return credentials
  if(typeof runtimeRoot!=='string'||!runtimeRoot.trim()||runtimeRoot.includes('\0'))throw fail('The Spur host has not configured private OAuth client storage.',503,'google_oauth_client_storage_unavailable')
  return createCredentialStore({root:join(resolve(runtimeRoot),'google-oauth-client')})
}
const storageFailure=()=>fail('The protected Google OAuth client could not be saved or opened on this host.',503,'google_oauth_client_storage_unavailable')

/** Save only application credentials, separately from every mailbox credential store. */
export async function importGoogleOAuthClient({runtimeRoot,document,credentials}={}){
  const pair=validateGoogleOAuthWebClient(document),store=clientStore({runtimeRoot,credentials})
  try{await store.set({schemaVersion:1,...pair,callback:CALLBACK})}catch{throw storageFailure()}
  return {configured:true,callback:CALLBACK,storage:store.storage}
}

/** Explicit complete environment/file pairs take priority over the local import. */
export async function loadGoogleOAuthConfig({runtimeRoot,config={},credentials}={}){
  for(const prefix of ['GMAIL','GOOGLE','YOUTUBE'])if(typeof config[`${prefix}_CLIENT_ID`]==='string'&&config[`${prefix}_CLIENT_ID`].trim()&&typeof config[`${prefix}_CLIENT_SECRET`]==='string'&&config[`${prefix}_CLIENT_SECRET`].trim())return config
  const store=clientStore({runtimeRoot,credentials})
  let saved;try{saved=await store.get()}catch{throw storageFailure()}
  if(saved===null||saved===undefined)return config
  if(!object(saved)||saved.schemaVersion!==1||saved.callback!==CALLBACK||!validPair(saved.clientId,saved.clientSecret))throw storageFailure()
  return {...config,GMAIL_CLIENT_ID:saved.clientId,GMAIL_CLIENT_SECRET:saved.clientSecret}
}

async function readDocument(file){
  let handle
  try{
    handle=await open(file,'r')
    const info=await handle.stat()
    if(!info.isFile()||info.size>MAX_DOCUMENT_BYTES)throw invalid()
    const buffer=Buffer.alloc(MAX_DOCUMENT_BYTES+1)
    let bytes=0
    while(bytes<buffer.length){const part=await handle.read(buffer,bytes,buffer.length-bytes,null);if(!part.bytesRead)break;bytes+=part.bytesRead}
    if(bytes>MAX_DOCUMENT_BYTES)throw invalid()
    return buffer.subarray(0,bytes).toString('utf8')
  }catch{throw invalid()}
  finally{await handle?.close().catch(()=>{})}
}

async function cli(args){
  if(args.length!==3||args[0]!=='import')throw fail('Usage: node google-oauth-client.mjs import <download-json-path> <runtime-root>')
  const store=clientStore({runtimeRoot:args[2]})
  if(store.storage==='session')throw fail('This host cannot persist protected OAuth clients. Configure matching GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in the Spur server environment, then restart Spur.',503,'google_oauth_client_persistence_unavailable')
  const document=await readDocument(args[1])
  const result=await importGoogleOAuthClient({runtimeRoot:args[2],document,credentials:store})
  process.stdout.write(JSON.stringify(result)+'\n')
}

// Importing this module never reads command-line files or starts the CLI.
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  try{await cli(process.argv.slice(2))}catch(error){
    process.stderr.write((typeof error?.code==='string'&&error.code.startsWith('google_oauth_client_')?error.message:'Google OAuth client import could not be completed.')+'\n')
    process.exitCode=1
  }
}
