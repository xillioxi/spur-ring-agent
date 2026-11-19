import test from 'node:test'
import assert from 'node:assert/strict'
import {replacePrivateFile} from './atomic-file.mjs'

test('a transient Windows index lock is retried within a small fixed budget',async()=>{
  let calls=0;const waits=[]
  await replacePrivateFile('private.tmp','index.json',{platform:'win32',renameImpl:async()=>{if(++calls<3)throw Object.assign(Error('locked'),{code:'EPERM'})},delay:async value=>waits.push(value)})
  assert.equal(calls,3);assert.deepEqual(waits,[20,60])
})
test('persistent locks stop, and non-lock errors never retry or delete the old index',async()=>{
  let calls=0
  await assert.rejects(replacePrivateFile('private.tmp','index.json',{platform:'win32',renameImpl:async()=>{calls++;throw Object.assign(Error('locked'),{code:'EBUSY'})},delay:async()=>{}}),{code:'EBUSY'})
  assert.equal(calls,4);calls=0
  await assert.rejects(replacePrivateFile('private.tmp','index.json',{platform:'win32',renameImpl:async()=>{calls++;throw Object.assign(Error('full'),{code:'ENOSPC'})},delay:async()=>{}}),{code:'ENOSPC'})
  assert.equal(calls,1)
})
