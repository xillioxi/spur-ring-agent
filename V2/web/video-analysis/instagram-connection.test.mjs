import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {createInstagramConnectionStore} from './instagram-connection.mjs'

const token='synthetic-private-token-123456789'
const accountId='12345678901'
async function fixture(t){const root=await mkdtemp(join(process.cwd(),'.spur-connection-test-'));t.after(()=>rm(root,{recursive:true,force:true}));return root}
const validateConnection=async config=>{assert.equal(config.SPUR_INSTAGRAM_ACCESS_TOKEN,token);return {handle:'my_creator'}}
const protect=async text=>Buffer.from(text).toString('base64')
const unprotect=async text=>Buffer.from(text,'base64').toString('utf8')

test('private connection validates, persists only protected data, reloads and disconnects without exposing token',async t=>{
  const root=await fixture(t),options={root,validateConnection,protect,unprotect}
  const store=createInstagramConnectionStore(options)
  assert.equal((await store.status()).connected,false)
  const result=await store.connect({accountId,accessToken:token})
  assert.equal(result.connected,true);assert.equal(result.handle,'my_creator');assert.equal(JSON.stringify(result).includes(token),false)
  const disk=await readFile(join(root,'private-connections','instagram.dpapi'),'utf8')
  assert.equal(disk.includes(token),false)
  const reopened=createInstagramConnectionStore(options)
  assert.deepEqual(await reopened.getConfig(),{SPUR_INSTAGRAM_ACCOUNT_ID:accountId,SPUR_INSTAGRAM_ACCESS_TOKEN:token})
  assert.equal((await reopened.disconnect()).connected,false)
  await assert.rejects(readFile(join(root,'private-connections','instagram.dpapi')),{code:'ENOENT'})
})

test('failed verification never replaces a working connection or echoes upstream secrets',async t=>{
  const root=await fixture(t)
  let reject=false
  const store=createInstagramConnectionStore({root,platform:'linux',validateConnection:async()=>{if(reject)throw Object.assign(new Error(token),{status:401});return {handle:'creator'}}})
  await store.connect({accountId,accessToken:token});reject=true
  await assert.rejects(store.connect({accountId,accessToken:'replacement-private-token-12345'}),error=>!error.message.includes(token)&&error.status===422)
  assert.equal((await store.getConfig()).SPUR_INSTAGRAM_ACCESS_TOKEN,token)
  assert.equal((await store.status()).storage,'session')
  assert.equal((await store.disconnect()).connected,false)
})

test('connection rejects malformed IDs and token input before network access',async t=>{
  const root=await fixture(t);let calls=0
  const store=createInstagramConnectionStore({root,platform:'linux',validateConnection:async()=>{calls++;return {}}})
  for(const value of [{accountId:'../x',accessToken:token},{accountId,accessToken:'has whitespace token'},{accountId,accessToken:'short'}])await assert.rejects(store.connect(value),{status:422})
  assert.equal(calls,0)
})

test('a first protected read completes before a concurrent replacement so old credentials cannot revive',async t=>{
  const root=await fixture(t),options={root,validateConnection,protect,unprotect}
  await createInstagramConnectionStore(options).connect({accountId,accessToken:token})
  let releaseDecrypt,notifyDecrypt,validationCalls=0
  const decryptStarted=new Promise(done=>{notifyDecrypt=done}),decryptReleased=new Promise(done=>{releaseDecrypt=done})
  const replacement='replacement-private-token-123456789'
  const reopened=createInstagramConnectionStore({root,protect,unprotect:async text=>{notifyDecrypt();await decryptReleased;return unprotect(text)},validateConnection:async()=>{validationCalls++;return {handle:'replacement_creator'}}})
  const reading=reopened.getConfig();await decryptStarted
  const replacing=reopened.connect({accountId,accessToken:replacement})
  // A resolved microtask would start an unprotected write immediately. It must
  // instead remain behind the in-flight protected read on the shared queue.
  await Promise.resolve();const writesBeforeReadFinished=validationCalls
  releaseDecrypt();await reading;await replacing
  assert.equal(writesBeforeReadFinished,0)
  assert.equal((await reopened.getConfig()).SPUR_INSTAGRAM_ACCESS_TOKEN,replacement)
  assert.equal((await reopened.status()).handle,'replacement_creator')
  assert.equal((await reopened.disconnect()).connected,false)
  assert.deepEqual(await reopened.getConfig(),{})
})

test('bearer token punctuation is accepted while whitespace and internal padding are rejected',async t=>{
  const root=await fixture(t);let calls=0
  const store=createInstagramConnectionStore({root,platform:'linux',validateConnection:async()=>{calls++;return {handle:'creator'}}})
  const bearer='Bearer_abc.def~ghi+jkl/mno-123=='
  await store.connect({accountId,accessToken:bearer})
  assert.equal((await store.getConfig()).SPUR_INSTAGRAM_ACCESS_TOKEN,bearer)
  for(const invalid of ['invalid=padding-inside-1234','token has whitespace-1234','invalid|pipe-token-123456'])await assert.rejects(store.connect({accountId,accessToken:invalid}),{status:422})
  assert.equal(calls,1)
})
