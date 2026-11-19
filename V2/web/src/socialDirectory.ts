import {useEffect,useState} from 'react'
import {getInstagramConnection} from './inverseVideoApi'
import {whatsappRequest,type WhatsAppStatus} from './whatsappApi'
import {backendScope} from './taskApi'
import {readYoutubeConnection} from './guestConnections'
import {readSocial} from './MetaMessages'

type Account={provider:string;label:string}
const initial={labels:{whatsapp:[] as string[],instagram:[] as string[],messenger:[] as string[]},instagram:'',other:[] as Account[]}
export function useSocialDirectory(revision=0){
  const [directory,setDirectory]=useState(initial)
  useEffect(()=>{
    let generation=0
    async function refresh(){
      const version=++generation
      const archive=async(provider:string)=>{
        const [saved,linked]=await Promise.all([
          readSocial<{threads:{account:string}[]}>('social-archives?provider='+provider),
          readSocial<{accounts:{label:string}[]}>('meta-inbox?provider='+provider),
        ])
        return [...linked.accounts.map(a=>a.label),...saved.threads.map(t=>t.account)]
      }
      const [wa,ig,instagram,messenger,other]=await Promise.allSettled([
        whatsappRequest<WhatsAppStatus>('/status'),getInstagramConnection(),archive('instagram'),archive('messenger'),backendScope.startsWith('guest:') ? readYoutubeConnection().then(connection=>({accounts:connection?.state==='connected'?[{provider:'YouTube',label:connection.label||'YouTube'}]:[]})) : readSocial<{accounts:Account[]}>('social-connections'),
      ])
      if(version!==generation)return
      const handle=ig.status==='fulfilled' && ig.value.connection.connected ? ig.value.connection.handle || ig.value.connection.accountId || 'Connected Instagram account' : ''
      setDirectory(previous=>({
        instagram:ig.status==='fulfilled'?handle:previous.instagram,
        labels:{
          whatsapp:wa.status==='fulfilled'?wa.value.sources.map(id=>id==='imported'?'Imported chats':id.split('@')[0]):previous.labels.whatsapp,
          instagram:[...new Set([handle,...(instagram.status==='fulfilled'?instagram.value:previous.labels.instagram)].filter(Boolean))],
          messenger:messenger.status==='fulfilled'?[...new Set(messenger.value)]:previous.labels.messenger,
        },
        other:other.status==='fulfilled'?other.value.accounts:previous.other,
      }))
    }
    void refresh();window.addEventListener('focus',refresh)
    return ()=>{generation++;window.removeEventListener('focus',refresh)}
  },[revision])
  return directory
}
