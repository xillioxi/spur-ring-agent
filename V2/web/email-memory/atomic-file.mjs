import {rename} from 'node:fs/promises'

/** Windows scanners can hold a just-written index briefly. Never delete the old
 * destination or retry non-lock errors; an exhausted attempt preserves it. */
export async function replacePrivateFile(source,target,{renameImpl=rename,platform=process.platform,delay=milliseconds=>new Promise(done=>setTimeout(done,milliseconds))}={}){
  const waits=[20,60,150]
  for(let attempt=0;;attempt++){
    try{return await renameImpl(source,target)}catch(error){
      if(platform!=='win32'||!['EPERM','EACCES','EBUSY'].includes(error?.code)||attempt>=waits.length)throw error
      await delay(waits[attempt])
    }
  }
}
