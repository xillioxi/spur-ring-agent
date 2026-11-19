import {createHash} from 'node:crypto'
import {mkdirSync} from 'node:fs'
import {join} from 'node:path'

const providers = new Set(['instagram','messenger'])
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const invalid = message => Object.assign(new Error(message),{status:422})
// Meta exports sometimes encode UTF-8 bytes as individual Latin-1 characters.
function label(value) {
  if (typeof value !== 'string') return ''
  if (!/[^\x00-\x7f]/.test(value) || /[^\x00-\xff]/.test(value)) return value
  try { return new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(value,'latin1')) } catch { return value }
}

export async function openSocialArchive(root){
    const {DatabaseSync}=await import('node:sqlite')
    mkdirSync(root,{recursive:true,mode:0o700})
    const db=new DatabaseSync(join(root,'social-archives.sqlite'))
    db.exec('CREATE TABLE IF NOT EXISTS threads(id TEXT PRIMARY KEY,provider TEXT,account TEXT,title TEXT); CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,thread TEXT,time INTEGER,sender TEXT,body TEXT); CREATE INDEX IF NOT EXISTS thread_time ON messages(thread,time)')
    db.exec('CREATE TABLE IF NOT EXISTS meta_checkpoints(thread TEXT PRIMARY KEY, updated TEXT)')
    return db
}

export async function handleSocialArchive(req,res,root,url) {
  const send = (status,value) => {
    res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'})
    res.end(JSON.stringify(value))
  }
  let db
  try {
    const provider = url.searchParams.get('provider')
    if (!providers.has(provider)) throw invalid('Choose Instagram or Messenger.')
    let payload
    if (req.method === 'POST') {
      const chunks=[]
      let size=0
      for await (const chunk of req) {
        size+=chunk.length
        if(size>40*1024*1024) throw invalid('Each message JSON file must be under 40 MiB.')
        chunks.push(chunk)
      }
      try { payload=JSON.parse(Buffer.concat(chunks).toString()) } catch { throw invalid('Choose a valid message JSON file.') }
      if (!Array.isArray(payload?.messages) || (payload.participants != null && !Array.isArray(payload.participants))) throw invalid('Choose a Meta conversation file such as message_1.json.')
    } else if(req.method !== 'GET') return send(405,{error:'Use GET or POST.'})
    db=await openSocialArchive(root)
    if(req.method==='POST'){
      const account=(url.searchParams.get('account')||'').trim()
      const title=label(payload.title) || (payload.participants||[]).map(person=>label(person?.name)).filter(Boolean).sort().join(', ')
      if(!account || account.length>160 || !title) throw invalid('Provide an account and a conversation with a title or participants.')
      const id=digest([provider,account.toLowerCase(),payload.thread_path||title])
      db.exec('BEGIN IMMEDIATE')
      const insert=db.prepare('INSERT OR IGNORE INTO messages VALUES(?,?,?,?,?)')
      let added=0, readable=0
      for(const message of payload.messages){
        const sender=label(message?.sender_name), time=message?.timestamp_ms, body=label(message?.content) || label(message?.share?.link)
        if(!sender || !Number.isSafeInteger(time) || !body) continue
        readable++
        added+=Number(insert.run(digest([id,time,sender,body]),id,time,sender,body).changes)
      }
      if(!readable) throw invalid('This conversation file contains no text messages or shared links.')
      db.prepare('INSERT INTO threads VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title').run(id,provider,account,title)
      db.exec('COMMIT')
      return send(200,{added})
    }
    const thread=url.searchParams.get('thread')
    if (thread) {
      const offset=Number(url.searchParams.get('offset')||0)
      if(!Number.isSafeInteger(offset)||offset<0)throw invalid('Invalid message offset.')
      return send(200,{messages:db.prepare('SELECT m.id,m.sender,m.time,m.body FROM messages m JOIN threads t ON t.id=m.thread WHERE t.provider=? AND t.id=? ORDER BY m.time DESC,m.id LIMIT 100 OFFSET ?').all(provider,thread,offset)})
    }
    return send(200,{threads:db.prepare('SELECT t.id,t.account,t.title,count(*) AS count FROM threads t JOIN messages m ON m.thread=t.id WHERE t.provider=? GROUP BY t.id ORDER BY max(m.time) DESC,t.id').all(provider)})
  }catch(error){send(error.status||500,{error:error.status?error.message:'Could not access the saved social messages.'})}
  finally{db?.close()}
}
