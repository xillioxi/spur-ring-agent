export const EMAIL_MEMORY_PREFIX='/api/creator-agent/email-memory'
export function emailMemoryReadToolRoute(path,method){
  return method==='GET'&&(path===EMAIL_MEMORY_PREFIX+'/status'||path===EMAIL_MEMORY_PREFIX+'/graph'||path===EMAIL_MEMORY_PREFIX+'/messages'||new RegExp('^'+EMAIL_MEMORY_PREFIX+'/messages/(?:[A-Za-z0-9_-]{1,1024}|imap(?:%3[aA]|:)[0-9]{1,30}(?:%3[aA]|:)[0-9]{1,30})$').test(path))
}
