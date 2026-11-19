import {mkdir,lstat,realpath,readFile,writeFile,rename,unlink} from 'node:fs/promises'
import {resolve,join,relative,isAbsolute} from 'node:path'
import {spawn} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {validateInstagramConnection} from './instagram-discovery.mjs'

const stores=new Map()
const fail=(message,status=422,code='instagram_connection_failed')=>Object.assign(new Error(message),{status,code})
const inside=(root,file)=>{const part=relative(root,file);return !part.startsWith('..')&&!isAbsolute(part)}
const validId=value=>typeof value==='string'&&/^\d{5,40}$/.test(value)
const validToken=value=>typeof value==='string'&&value.length>=16&&value.length<=8192&&/^[A-Za-z0-9._~+\/-]+=*$/.test(value)

// Windows protects the token for this OS user. The token is supplied on stdin,
// never in a command argument, process environment or diagnostic output.
function windowsProtection(value,decrypt=false) {
  const action=decrypt
    ? '[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($value),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))'
    : '[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($value),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))'
  const script=`$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $value=[Console]::In.ReadToEnd(); [Console]::Out.Write(${action})`
  return new Promise((resolveResult,reject)=>{
    const child=spawn('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,stdio:['pipe','pipe','pipe']})
    const chunks=[];let size=0,settled=false
    const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolveResult(result)}
    const timer=setTimeout(()=>{child.kill();finish(fail('The local secure credential store did not respond.',503))},10000)
    child.stdout.on('data',chunk=>{size+=chunk.length;if(size>32*1024){child.kill();finish(fail('The local secure credential store returned invalid data.',503))}else chunks.push(chunk)})
    child.stderr.resume()
    child.on('error',()=>finish(fail('The local secure credential store is unavailable.',503)))
    child.on('close',code=>finish(code===0?null:fail('The local secure credential store could not open this connection. Reconnect Instagram.',503),Buffer.concat(chunks).toString('utf8')))
    child.stdin.on('error',()=>{})
    child.stdin.end(value)
  })
}

export function createInstagramConnectionStore({root,config={},validateConnection=validateInstagramConnection,protect,unprotect,platform=process.platform}={}) {
  if(typeof root!=='string'||!root.trim())throw fail('Private video storage is unavailable.',503)
  const storageRoot=resolve(root)
  // Custom protectors/validators are isolated test instances, never production caches.
  const cached=!protect&&!unprotect&&validateConnection===validateInstagramConnection&&stores.get(storageRoot)
  if(cached){cached.configure(config);return cached}
  let hostConfig=config,credential,loaded=false,serial=Promise.resolve()
  const exclusive=work=>{const result=serial.then(work,work);serial=result.catch(()=>{});return result}
  const persistent=platform==='win32'||!!(protect&&unprotect)
  const encrypt=protect||(value=>windowsProtection(value))
  const decrypt=unprotect||(value=>windowsProtection(value,true))
  const directory=join(storageRoot,'private-connections'),file=join(directory,'instagram.dpapi')
  async function safeDirectory(){
    await mkdir(storageRoot,{recursive:true,mode:0o700})
    const rootInfo=await lstat(storageRoot)
    if(rootInfo.isSymbolicLink()||!rootInfo.isDirectory())throw fail('Private video storage is unavailable.',503)
    await mkdir(directory,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error})
    const info=await lstat(directory),actualRoot=await realpath(storageRoot),actual=await realpath(directory)
    if(info.isSymbolicLink()||!info.isDirectory()||!inside(actualRoot,actual))throw fail('Private connection storage is unavailable.',503)
    const current=await lstat(file).catch(error=>{if(error.code!=='ENOENT')throw error;return null})
    if(current&&(current.isSymbolicLink()||!current.isFile()||current.size>32*1024))throw fail('Private connection storage is invalid. Reconnect Instagram.',503)
  }
  async function load(){
    if(loaded)return
    if(persistent){
      await safeDirectory()
      const encrypted=await readFile(file,'utf8').catch(error=>{if(error.code!=='ENOENT')throw error;return null})
      if(encrypted){
        let value
        try{value=JSON.parse(await decrypt(encrypted))}catch{throw fail('The saved Instagram connection could not be opened. Reconnect Instagram.',503)}
        if(!validId(value?.accountId)||!validToken(value?.accessToken))throw fail('The saved Instagram connection is invalid. Reconnect Instagram.',503)
        credential={accountId:value.accountId,accessToken:value.accessToken,handle:typeof value.handle==='string'?value.handle.slice(0,30):undefined}
      }
    }
    loaded=true
  }
  function configured(){return validId(hostConfig.SPUR_INSTAGRAM_ACCOUNT_ID)&&validToken(hostConfig.SPUR_INSTAGRAM_ACCESS_TOKEN)}
  function publicStatus(){
    const connected=!!credential||configured()
    return {connected,method:'meta_business_discovery',...(credential?{accountId:credential.accountId,handle:credential.handle}:configured()?{accountId:hostConfig.SPUR_INSTAGRAM_ACCOUNT_ID}:{}),storage:persistent?'os_protected':'session',managed:!credential&&configured(),message:connected?(persistent?'Instagram connection saved privately on this computer.':'Instagram is connected for this server session. Reconnect after restarting Spur.'):'Connect a professional Instagram account with Meta API access to discover complete public professional channel feeds.'}
  }
  const store={
    configure(next){hostConfig=next||{}},
    status(){return exclusive(async()=>{await load();return publicStatus()})},
    getConfig(){return exclusive(async()=>{await load();return credential?{SPUR_INSTAGRAM_ACCOUNT_ID:credential.accountId,SPUR_INSTAGRAM_ACCESS_TOKEN:credential.accessToken}:{}})},
    connect(value){
      const work=serial.then(async()=>{
        if(!validId(value?.accountId)||!validToken(value?.accessToken))throw fail('Enter your professional Instagram account ID and a valid Meta access token.')
        const next={accountId:value.accountId,accessToken:value.accessToken}
        let verified
        try{verified=await validateConnection({...hostConfig,SPUR_INSTAGRAM_ACCOUNT_ID:next.accountId,SPUR_INSTAGRAM_ACCESS_TOKEN:next.accessToken})}catch(error){throw fail(error?.status===429?'Meta temporarily limited connection requests. Try again later.':'Meta could not verify this professional Instagram connection. Check the account ID, token and required permissions.',error?.status===429?429:422)}
        if(typeof verified?.handle==='string')next.handle=verified.handle.slice(0,30)
        if(persistent){
          await safeDirectory()
          const encrypted=await encrypt(JSON.stringify(next)),temporary=join(directory,`instagram-${randomUUID()}.tmp`)
          try{await writeFile(temporary,encrypted,{flag:'wx',mode:0o600});await rename(temporary,file)}finally{await unlink(temporary).catch(()=>{})}
        }
        credential=next;loaded=true;return publicStatus()
      });serial=work.catch(()=>{});return work
    },
    disconnect(){
      const work=serial.then(async()=>{
        if(configured())throw fail('This Instagram connection is managed by the Spur host. Remove its Instagram configuration there to disconnect.',409)
        if(persistent){await safeDirectory();await unlink(file).catch(error=>{if(error.code!=='ENOENT')throw error})}
        credential=undefined;loaded=true;return publicStatus()
      });serial=work.catch(()=>{});return work
    },
  }
  if(!protect&&!unprotect&&validateConnection===validateInstagramConnection)stores.set(storageRoot,store)
  return store
}
