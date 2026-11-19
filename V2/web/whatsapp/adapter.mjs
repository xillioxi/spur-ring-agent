const quiet={level:'silent',trace(){},debug(){},info(){},warn(){},error(){},fatal(){},child(){return this}}
export async function startWhatsApp({session,onState,onBatch,sdk,onDiagnostic}) {
  const wa=sdk||await import('@whiskeysockets/baileys'),{default:QRCode}=await import('qrcode')
  const saved=await session.get(),auth=saved?JSON.parse(saved,wa.BufferJSON.reviver):{creds:wa.initAuthCreds(),keys:{}}
  const version=wa.fetchLatestWaWebVersion?(await wa.fetchLatestWaWebVersion({signal:AbortSignal.timeout(8000)})).version:undefined
  let stopped=false,socket,timer,attempt=0,eventQueue=Promise.resolve()
  const persist=()=>session.set(JSON.stringify(auth,wa.BufferJSON.replacer))
  const ephemeralChats=new Set()
  const state={creds:auth.creds,keys:{
    async get(type,ids){const result={};for(const id of ids){let value=auth.keys[type]?.[id];if(type==='app-state-sync-key'&&value)value=wa.proto.Message.AppStateSyncKeyData.fromObject(value);result[id]=value}return result},
    async set(data){for(const [type,values]of Object.entries(data)){auth.keys[type]||={};for(const [id,value]of Object.entries(values)){if(value)auth.keys[type][id]=value;else delete auth.keys[type][id]}}await persist()},
  }}
  function account(){return wa.jidNormalizedUser(socket?.user?.id||auth.creds.me?.id||'')}
  async function open(){
    if(stopped)return
    // The Desktop/DARWIN descriptor is rejected before QR issuance (upstream #2880).
    socket=wa.default({auth:state,logger:quiet,...(version?{version}:{}),browser:wa.Browsers.macOS('Chrome'),markOnlineOnConnect:false,syncFullHistory:true,shouldSyncHistoryMessage:()=>true,shouldIgnoreJid:jid=>jid==='status@broadcast'||jid.endsWith('@newsletter'),getMessage:async()=>undefined,connectTimeoutMs:30000})
    const current=socket
    socket.ev.process(events=>{
      eventQueue=eventQueue.then(async()=>{
        if(stopped||current!==socket)return
        if(events['creds.update']){Object.assign(auth.creds,events['creds.update']);await persist()}
        const update=events['connection.update']
        if(update?.qr){const qr=await QRCode.toDataURL(update.qr,{width:260,margin:2});if(!stopped)await onState({state:'pairing',qr,qrExpiresAt:Date.now()+60000})}
        if(update?.connection==='open'){attempt=0;await onState({state:'connected',accountId:account(),name:socket.user?.name||'',qr:null});await persist()}
        const history=events['messaging-history.set']
        for(const chat of [...(history?.chats||[]),...(events['chats.upsert']||[]),...(events['chats.update']||[])])if(chat.ephemeralExpiration>0)ephemeralChats.add(chat.id);else if(chat.ephemeralExpiration===0)ephemeralChats.delete(chat.id)
        if(account()&&(history||events['contacts.update']||events['lid-mapping.update']||events['messages.upsert']||events['contacts.upsert']||events['chats.upsert']||events['chats.update']||events['messages.delete'])) {
          const deleted=[...(events['messages.delete']?.keys||[])]
          const mappings=[...(history?.lidPnMappings||[])]
          if(events['lid-mapping.update'])mappings.push(events['lid-mapping.update'])
          const messages=[...(history?.messages||[]),...(events['messages.upsert']?.messages||[])].map(message=>{
            const primary = message.key.participant || message.key.remoteJid
            const alternate = message.key.participant ? message.key.participantAlt : message.key.remoteJidAlt
            if (primary && alternate) mappings.push(primary.endsWith('@lid') ? {lid:primary,pn:alternate} : {lid:alternate,pn:primary})
            const content=wa.normalizeMessageContent(message.message)
            if(content?.protocolMessage?.type===0&&content.protocolMessage.key){deleted.push(content.protocolMessage.key);return null}
            // Disappearing/view-once content is deliberately not archived.
            if(ephemeralChats.has(message.key.remoteJid)||message.message?.viewOnceMessage||message.message?.viewOnceMessageV2||message.message?.viewOnceMessageV2Extension||message.message?.ephemeralMessage||Object.values(content||{}).some(value=>value?.contextInfo?.expiration))return null
            const text=content?.conversation||content?.extendedTextMessage?.text||content?.imageMessage?.caption||content?.videoMessage?.caption||content?.documentMessage?.caption||''
            if(!text)return null
            return {id:message.key.id,chatId:wa.jidNormalizedUser(message.key.remoteJid),senderId:wa.jidNormalizedUser(message.key.fromMe?account():message.key.participant||message.key.remoteJid),senderName:message.verifiedBizName||message.pushName||'',fromMe:!!message.key.fromMe,text,timestamp:Number(message.messageTimestamp)*1000}
          }).filter(Boolean)
          await onBatch({accountId:account(),messages,mappings,deleted:deleted.map(key=>({chatId:wa.jidNormalizedUser(key.remoteJid),sourceId:key.id})),contacts:[...(history?.contacts||[]),...(events['contacts.upsert']||[]),...(events['contacts.update']||[])],chats:[...(history?.chats||[]),...(events['chats.upsert']||[]),...(events['chats.update']||[])],historyReceived:!!history})
        }
        if(update?.connection==='close') {
          const code=update.lastDisconnect?.error?.output?.statusCode
          onDiagnostic?.({code,errorType:update.lastDisconnect?.error?.name,reason:String(update.lastDisconnect?.error?.message||'').slice(0,120)})
          if(code===wa.DisconnectReason.loggedOut){await session.clear();await onState({state:'disconnected',qr:null,disconnectCode:code,message:'WhatsApp rejected or unlinked this device. Link again to resume.'});return}
          if(attempt++<4){await onState({state:'reconnecting',qr:null});timer=setTimeout(()=>{void open().catch(failed)},code===wa.DisconnectReason.restartRequired?500:Math.min(15000,attempt*2500));timer.unref?.()}
          else await onState({state:'disconnected',qr:null,disconnectCode:Number.isInteger(code)?code:undefined,message:'Connection stopped. Reconnect to try again; saved messages remain available.'})
        }
      }).catch(failed)
      return eventQueue
    })
  }
  async function failed(){if(stopped)return;await onState({state:'failed',qr:null,message:'WhatsApp could not finish connecting or saving messages. Reconnect to try again.'});socket?.end(new Error('WhatsApp connection stopped'))}
  await open()
  return {
    businessProfile: id => socket.getBusinessProfile(id),
    profilePhoto: id => socket.profilePictureUrl(id, 'preview', 6000),
    async stop({unlink=false}={}){stopped=true;clearTimeout(timer);if(unlink){await socket?.logout().catch(()=>{});await session.clear()}socket?.end(new Error('Spur stopped the WhatsApp session'));await eventQueue},
  }
}
