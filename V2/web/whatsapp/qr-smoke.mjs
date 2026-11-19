// Opt-in live transport check: creates an unlinked QR only, with memory-only auth.
import {startWhatsApp} from './adapter.mjs'
let adapter,settled=false,finish
const result=new Promise(resolve=>{finish=resolve})
const timer=setTimeout(()=>{if(!settled){settled=true;finish({ok:false,reason:'QR was not received within 40 seconds'})}},40000)
try{
  const session={storage:'session',get:async()=>null,set:async()=>{},clear:async()=>{}}
  adapter=await startWhatsApp({session,onBatch:async()=>{},onDiagnostic:value=>console.log(JSON.stringify({connectionDiagnostic:value})),onState:async state=>{
    if(!settled&&state.state==='pairing'&&state.qr?.startsWith('data:image/png;base64,')){settled=true;finish({ok:true,qrGenerated:true})}
    if(!settled&&['failed','disconnected'].includes(state.state)){settled=true;finish({ok:false,state:state.state,disconnectCode:state.disconnectCode})}
  }})
  const value=await result;console.log(JSON.stringify(value));process.exitCode=value.ok?0:1
}finally{clearTimeout(timer);await adapter?.stop()}
