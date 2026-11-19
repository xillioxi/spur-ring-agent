import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync,readFileSync,statSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {saveTaskResult,readTaskResult} from './task-results.mjs'
function folder(t){const p=mkdtempSync(join(tmpdir(),'spur-task-result-'));t.after(()=>rmSync(p,{recursive:true,force:true}));return p}
test('persists result privately, readable by later process without rerunning tools',t=>{
 const p=folder(t);const result={runId:'id',response:'finished report',artifacts:[]};saveTaskResult(p,result)
 assert.deepEqual(readTaskResult(p,'id',()=>{throw Error('Should not execute')}),result)
 // Windows does not expose POSIX permission bits through stat.
 if(process.platform!=='win32') assert.equal(statSync(join(p,'result.json')).mode & 0o777,0o600)
})
test('recovers old completed task stdout once and persists it',t=>{
 const p=folder(t);writeFileSync(join(p,'terminal.txt'),'Recovered final answer');let calls=0
 const collect=()=>{calls++;return {sources:[],artifacts:[]}}
 assert.equal(readTaskResult(p,'old',collect).response,'Recovered final answer')
 readTaskResult(p,'old',collect);assert.equal(calls,1)
})
test('rejects corrupt or mismatched results instead of fabricating success',t=>{
 const p=folder(t);writeFileSync(join(p,'result.json'),'{broken');assert.throws(()=>readTaskResult(p,'id',()=>({})))
 saveTaskResult(p,{runId:'other',response:'x'});assert.throws(()=>readTaskResult(p,'id',()=>({})))
})
