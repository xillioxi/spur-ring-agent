import {lookup} from 'node:dns/promises'
import {isIP,BlockList} from 'node:net'

const deny4=new BlockList(),global6=new BlockList(),deny6=new BlockList()
for(const [address,prefix]of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3]])deny4.addSubnet(address,prefix,'ipv4')
global6.addSubnet('2000::',3,'ipv6')
for(const [address,prefix]of [['2001::',32],['2001:db8::',32],['2002::',16]])deny6.addSubnet(address,prefix,'ipv6')
const fail=()=>Object.assign(new Error('Use a public email server hostname with verified TLS on port 993.'),{status:422,code:'invalid_imap_host'})
export function publicImapAddress(address){
  if(typeof address!=='string')return false
  const family=isIP(address)
  return family===4?!deny4.check(address,'ipv4'):family===6&&global6.check(address,'ipv6')&&!deny6.check(address,'ipv6')
}
function hostname(value){
  if(typeof value!=='string'||value.length>253)throw fail()
  const host=value.trim().toLowerCase()
  if(!host||isIP(host)||!host.includes('.')||host.split('.').some(label=>!(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))||!/[a-z]/.test(host.split('.').at(-1))||/(?:^|\.)(?:localhost|local|internal|invalid|test|onion)$/.test(host))throw fail()
  return host
}

/** Resolve once, reject every nonpublic answer, then pin TLS lookup to that set.
 * ImapFlow forwards tls options to Node's tls.connect; SNI still uses the hostname.
 */
export async function resolveImapEndpoint({host:rawHost,port=993,lookupImpl=lookup}={}){
  const host=hostname(rawHost)
  if(port!==993)throw fail()
  let timer,addresses
  try{addresses=await Promise.race([lookupImpl(host,{all:true,verbatim:true}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(fail()),10000)})])}catch{throw Object.assign(new Error('The email server hostname could not be resolved. Check its region and hostname, then try again.'),{status:502,code:'imap_dns_failed'})}finally{clearTimeout(timer)}
  if(!Array.isArray(addresses)||!addresses.length||addresses.length>32||addresses.some(item=>!publicImapAddress(item?.address)||item.family!==isIP(item.address)))throw fail()
  const pinned=[...new Map(addresses.map(item=>[item.address,{address:item.address,family:item.family}])).values()]
  function pinnedLookup(name,options,callback){
    if(typeof options==='function'){callback=options;options={}}
    const requestedFamily=typeof options==='number'?options:options?.family||0
    const matching=pinned.filter(item=>!requestedFamily||item.family===requestedFamily)
    queueMicrotask(()=>{
      if(name?.toLowerCase()!==host||!matching.length)return callback(fail())
      if(options?.all)return callback(null,matching.map(item=>({...item})))
      callback(null,matching[0].address,matching[0].family)
    })
  }
  return {host,port:993,secure:true,tls:{servername:host,rejectUnauthorized:true,minVersion:'TLSv1.2',lookup:pinnedLookup}}
}
