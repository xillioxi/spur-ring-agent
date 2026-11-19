import {mkdir,lstat,realpath,readFile,writeFile,rename,unlink} from 'node:fs/promises'
import {resolve,join,relative,isAbsolute} from 'node:path'
import {spawn} from 'node:child_process'
import {randomUUID} from 'node:crypto'

const fail=()=>Object.assign(new Error('The private Gmail connection could not be opened. Reconnect Gmail.'),{status:503,code:'gmail_storage_unavailable'})
const inside=(root,path)=>{const part=relative(root,path);return !part.startsWith('..')&&!isAbsolute(part)}
function dpapi(value,decrypt=false){
  const action=decrypt?'[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($value),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))':'[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($value),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))'
  const script=`$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $value=[Console]::In.ReadToEnd(); [Console]::Out.Write(${action})`
  return new Promise((done,reject)=>{
    const child=spawn('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,stdio:['pipe','pipe','pipe']})
    const chunks=[];let bytes=0,settled=false
    const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):done(result)}
    const timer=setTimeout(()=>{child.kill();finish(fail())},10000)
    child.stdout.on('data',part=>{bytes+=part.length;if(bytes>128*1024){child.kill();finish(fail())}else chunks.push(part)})
    child.stderr.resume();child.stdin.on('error',()=>{})
    child.on('error',()=>finish(fail()))
    child.on('close',code=>finish(code===0?null:fail(),Buffer.concat(chunks).toString('utf8')))
    child.stdin.end(value)
  })
}

/** Private host-only JSON credentials. Every operation shares one serialization queue. */
export function createCredentialStore({root,platform=process.platform,protect,unprotect}={}){
  const storageRoot=resolve(root),directory=join(storageRoot,'private-connections'),file=join(directory,'gmail.dpapi')
  const persistent=platform==='win32'||!!(protect&&unprotect)
  const encrypt=protect||(value=>dpapi(value)),decrypt=unprotect||(value=>dpapi(value,true))
  let loaded=false,value=null,serial=Promise.resolve()
  const exclusive=work=>{const next=serial.then(work,work);serial=next.catch(()=>{});return next}
  async function safe(){
    await mkdir(storageRoot,{recursive:true,mode:0o700})
    if((await lstat(storageRoot)).isSymbolicLink())throw fail()
    await mkdir(directory,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error})
    const directoryInfo=await lstat(directory)
    if(directoryInfo.isSymbolicLink()||!directoryInfo.isDirectory()||!inside(await realpath(storageRoot),await realpath(directory)))throw fail()
    const info=await lstat(file).catch(error=>{if(error.code!=='ENOENT')throw error;return null})
    if(info&&(info.isSymbolicLink()||!info.isFile()||info.size>128*1024))throw fail()
  }
  async function load(){
    if(loaded)return
    try{
      if(persistent){await safe();const stored=await readFile(file,'utf8').catch(error=>{if(error.code!=='ENOENT')throw error;return null});if(stored){value=JSON.parse(await decrypt(stored));if(!value||typeof value!=='object'||Array.isArray(value))throw fail()}}
      loaded=true
    }catch{throw fail()}
  }
  return {
    storage:persistent?'os_protected':'session',
    get(){return exclusive(async()=>{await load();return value?structuredClone(value):null})},
    set(next){return exclusive(async()=>{
      if(!next||typeof next!=='object'||Array.isArray(next)||Buffer.byteLength(JSON.stringify(next))>32*1024)throw fail()
      if(persistent){await safe();const encrypted=await encrypt(JSON.stringify(next)),temporary=join(directory,`gmail-${randomUUID()}.tmp`);try{await writeFile(temporary,encrypted,{flag:'wx',mode:0o600});await rename(temporary,file)}finally{await unlink(temporary).catch(()=>{})}}
      value=structuredClone(next);loaded=true
    })},
    clear(){return exclusive(async()=>{if(persistent){await safe();await unlink(file).catch(error=>{if(error.code!=='ENOENT')throw error})}value=null;loaded=true})},
  }
}
