import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {createCredentialStore} from './credential-store.mjs'

async function fixture(t){const root=await mkdtemp(join(process.cwd(),'.spur-gmail-secrets-test-'));t.after(()=>rm(root,{recursive:true,force:true}));return root}
const protect=async value=>Buffer.from(value).toString('base64'),unprotect=async value=>Buffer.from(value,'base64').toString('utf8')
test('Gmail credentials persist only protected bytes and clear without exposing raw secrets',async t=>{
  const root=await fixture(t),secret={email:'owner@example.com',appPassword:'synthetic-secret'}
  const store=createCredentialStore({root,protect,unprotect});await store.set(secret)
  assert.equal((await readFile(join(root,'private-connections','gmail.dpapi'),'utf8')).includes(secret.appPassword),false)
  const reopened=createCredentialStore({root,protect,unprotect});assert.deepEqual(await reopened.get(),secret)
  await reopened.clear();assert.equal(await reopened.get(),null)
  await assert.rejects(readFile(join(root,'private-connections','gmail.dpapi')),{code:'ENOENT'})
})
test('delayed credential read cannot revive secrets after a queued disconnect',async t=>{
  const root=await fixture(t),first=createCredentialStore({root,protect,unprotect});await first.set({token:'old'})
  let release,entered
  const began=new Promise(done=>entered=done),resume=new Promise(done=>release=done)
  const reopened=createCredentialStore({root,protect,unprotect:async value=>{entered();await resume;return unprotect(value)}})
  const read=reopened.get();await began;const clear=reopened.clear();release();await read;await clear;assert.equal(await reopened.get(),null)
})
