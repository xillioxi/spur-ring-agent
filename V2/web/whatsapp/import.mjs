import {createHash} from 'node:crypto'
// Phone exports: Android "date, time - sender: text" and iOS "[date, time] sender: text".
export function parseWhatsAppExport(text,{dateOrder='DMY',timezoneOffset=0}={}) {
  if(!['DMY','MDY'].includes(dateOrder)||!Number.isInteger(timezoneOffset)||Math.abs(timezoneOffset)>840)throw Object.assign(new Error('Choose the export date format and timezone.'),{status:400})
  const messages=[];let current,ignoredLines=0
  for(const raw of text.replace(/^\uFEFF/,'').split(/\r?\n/)){
    const line=raw.replace(/[\u200e\u200f\u202a-\u202e]/g,''),match=/^\[?(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?\]?\s*(?:-\s*)?(.*)$/i.exec(line)
    if(match){
      current=null
      const [,a,b,c,h,m,s,ampm,body]=match,year=Number(c)<100?2000+Number(c):Number(c),month=Number(dateOrder==='DMY'?b:a),day=Number(dateOrder==='DMY'?a:b),hour=ampm?Number(h)%12+(/pm/i.test(ampm)?12:0):Number(h),minute=Number(m),second=Number(s||0)
      const stamp=Date.UTC(year,month-1,day,hour,minute,second),date=new Date(stamp),sender=/^([^:\n]{1,160}):\s(.*)$/.exec(body)
      if(month<1||month>12||day<1||hour>23||minute>59||second>59||date.getUTCDate()!==day||!sender){ignoredLines++;continue}
      current={senderName:sender[1].trim(),text:sender[2],timestamp:stamp+timezoneOffset*60000};messages.push(current)
    }else if(current)current.text+='\n'+line
    else if(line.trim())ignoredLines++
  }
  const filtered=messages.filter(message=>!/^<?(?:media omitted|attached:|image omitted|video omitted|audio omitted)|^This message was deleted\.?$/i.test(message.text.trim()))
  for(const message of filtered)message.id='export-'+createHash('sha256').update(JSON.stringify([message.senderName,message.timestamp,message.text])).digest('hex').slice(0,32)
  return {messages:filtered,ignoredLines,skippedMessages:messages.length-filtered.length}
}
