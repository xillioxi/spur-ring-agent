import test from 'node:test'
import assert from 'node:assert/strict'
import {resolveImapEndpoint,publicImapAddress} from './imap-host.mjs'

test('custom IMAP excludes local, reserved, mapped, multicast and documentation networks',()=>{
  for(const address of ['127.0.0.1','10.0.0.1','172.20.1.1','192.168.1.1','100.64.1.1','169.254.169.254','192.0.0.1','192.0.2.1','198.51.100.3','203.0.113.8','198.18.0.1','224.1.1.1','255.255.255.255','::1','::ffff:127.0.0.1','::ffff:8.8.8.8','fe80::1','fc00::1','2001:db8::1','2002:7f00:1::','2001::1'])assert.equal(publicImapAddress(address),false,address)
  for(const address of ['8.8.8.8','1.1.1.1','2607:f8b0:400a:80a::2005'])assert.equal(publicImapAddress(address),true,address)
})
test('host input is never treated as a URL, IP literal, credential or arbitrary local port',async()=>{
  let calls=0
  const lookupImpl=async()=>{calls++;return [{address:'8.8.8.8',family:4}]}
  for(const host of ['localhost','mail.localhost','mail.internal','127.0.0.1','2130706433','[::1]','https://mail.example.net','user:password@mail.example.net','mail.example.net/path','mail.example.net:993','mail.example.net.','mail..example.net'])await assert.rejects(resolveImapEndpoint({host,lookupImpl}),{code:'invalid_imap_host'})
  await assert.rejects(resolveImapEndpoint({host:'mail.example.net',port:143,lookupImpl}),{code:'invalid_imap_host'});assert.equal(calls,0)
})
test('mixed public/private DNS fails before credentials are sent and errors hide resolver diagnostics',async()=>{
  await assert.rejects(resolveImapEndpoint({host:'mail.example.net',lookupImpl:async()=>[{address:'8.8.8.8',family:4},{address:'10.0.0.1',family:4}]}),{code:'invalid_imap_host'})
  await assert.rejects(resolveImapEndpoint({host:'mail.example.net',lookupImpl:async()=>{throw Error('secret resolver diagnostics')}}),error=>!error.message.includes('secret'))
})
test('TLS uses the verified hostname and a pinned lookup that never performs a second DNS request',async()=>{
  let calls=0
  const endpoint=await resolveImapEndpoint({host:'MAIL.EXAMPLE.NET',lookupImpl:async()=>{calls++;return [{address:'8.8.8.8',family:4},{address:'2607:f8b0:400a:80a::2005',family:6}]}})
  assert.equal(endpoint.host,'mail.example.net');assert.equal(endpoint.tls.servername,'mail.example.net');assert.equal(endpoint.tls.rejectUnauthorized,true);assert.equal(endpoint.secure,true)
  const resolvePinned=(name,options)=>new Promise((done,reject)=>endpoint.tls.lookup(name,options,(error,...values)=>error?reject(error):done(values)))
  assert.deepEqual(await resolvePinned('mail.example.net',{family:4}),['8.8.8.8',4])
  assert.deepEqual(await resolvePinned('mail.example.net',{all:true}),[[{address:'8.8.8.8',family:4},{address:'2607:f8b0:400a:80a::2005',family:6}]])
  await assert.rejects(resolvePinned('other.example.net',{}),{code:'invalid_imap_host'});assert.equal(calls,1)
})
