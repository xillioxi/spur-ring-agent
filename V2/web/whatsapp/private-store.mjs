import {mkdir,lstat,realpath,readFile,writeFile,unlink} from 'node:fs/promises'
import {resolve,join,relative,isAbsolute} from 'node:path'
import {randomUUID,randomBytes,createCipheriv,createDecipheriv} from 'node:crypto'
import {replacePrivateFile} from '../email-memory/atomic-file.mjs'
import {createCredentialStore} from '../email-memory/credential-store.mjs'

export const storageError=()=>Object.assign(new Error('WhatsApp private storage could not be opened. Saved files were preserved.'),{status:503})
export function privateStore(root) {
  const directory=resolve(root)
  async function safe(name) {
    if(!/^[a-z-]+\.json$/.test(name))throw storageError()
    await mkdir(directory,{recursive:true,mode:0o700})
    if((await lstat(directory)).isSymbolicLink())throw storageError()
    const file=join(directory,name),info=await lstat(file).catch(error=>{if(error.code!=='ENOENT')throw error;return null})
    if(info){const part=relative(await realpath(directory),await realpath(file));if(info.isSymbolicLink()||!info.isFile()||info.size>100*1024*1024||part.startsWith('..')||isAbsolute(part))throw storageError()}
    return file
  }
  return {
    async read(name){const file=await safe(name);try{return JSON.parse(await readFile(file,'utf8'))}catch(error){if(error.code==='ENOENT')return null;throw storageError()}},
    async write(name,value){const file=await safe(name),data=JSON.stringify(value);if(Buffer.byteLength(data)>100*1024*1024)throw storageError();const temp=join(directory,`.whatsapp-${randomUUID()}.tmp`);try{await writeFile(temp,data,{flag:'wx',mode:0o600});await replacePrivateFile(temp,file)}finally{await unlink(temp).catch(()=>{})}},
    async remove(name){const file=await safe(name);await unlink(file).catch(error=>{if(error.code!=='ENOENT')throw error})},
  }
}

// Persist only ciphertext; Windows DPAPI protects the encryption key. Other hosts
// keep the linked-device session in memory until an OS keychain is configured.
export function encryptedSession(root,{keyStore=createCredentialStore({root:join(root,'session-key')})}={}) {
  const files=privateStore(root);let key,serial=Promise.resolve(),memory=null
  const exclusive=work=>{const next=serial.then(work,work);serial=next.catch(()=>{});return next}
  async function secret(){if(!key){const saved=await keyStore.get();key=saved?.key?Buffer.from(saved.key,'base64'):randomBytes(32);if(key.length!==32)throw storageError();if(!saved)await keyStore.set({key:key.toString('base64')})}return key}
  return {
    storage:keyStore.storage,
    get:()=>exclusive(async()=>{if(keyStore.storage==='session')return memory;const envelope=await files.read('auth.json');if(!envelope)return null;try{const decipher=createDecipheriv('aes-256-gcm',await secret(),Buffer.from(envelope.iv,'base64'));decipher.setAuthTag(Buffer.from(envelope.tag,'base64'));return Buffer.concat([decipher.update(Buffer.from(envelope.data,'base64')),decipher.final()]).toString('utf8')}catch{throw storageError()}}),
    set:value=>exclusive(async()=>{if(typeof value!=='string'||Buffer.byteLength(value)>16*1024*1024)throw storageError();if(keyStore.storage==='session'){memory=value;return}const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',await secret(),iv),data=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);await files.write('auth.json',{iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')})}),
    clear:()=>exclusive(async()=>{await files.remove('auth.json');await keyStore.clear();key=null;memory=null}),
  }
}
