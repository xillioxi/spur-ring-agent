export const relationshipLabels = Object.freeze({ friends:'Friends', family:'Family', colleagues:'Colleagues', services:'Services', company:'Companies', other:'Other contacts' })
const personalDomains = new Set(['gmail.com','googlemail.com','outlook.com','hotmail.com','live.com','msn.com','icloud.com','me.com','yahoo.com','yahoo.co.uk','proton.me','protonmail.com','aol.com','qq.com','163.com','zoho.com','zohomail.com'])
const clean = (value, max) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,max) : ''
const compoundSuffixes = new Set(['com.hk','org.hk','gov.hk','edu.hk','co.uk','org.uk','gov.uk','ac.uk','com.au','net.au','com.cn','com.my','com.sg','co.jp','co.nz','co.in'])
function organizationDomain(domain) {
  const parts=domain.split('.'),suffix=parts.slice(-2).join('.')
  return parts.slice(compoundSuffixes.has(suffix)?-3:-2).join('.')
}
export function normalizeContactProfile(value) {
  return { relationship: Object.hasOwn(relationshipLabels,value?.relationship) ? value.relationship : 'auto', company:clean(value?.company,120), role:clean(value?.role,200) }
}
// Suggestions from saved evidence, not claims about employment or friendship.
export function contactContext(node, self, authored, profile) {
  const saved = normalizeContactProfile(profile), domain = node.email.split('@')[1], local = node.email.split('@')[0]
  const corporate = !personalDomains.has(domain), evidence = []
  let relationship = 'other', company = corporate ? organizationDomain(domain) : '', role = '', source = 'unknown'
  const serviceRole = /(?:^|[+._-])(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|notifications?|notify|alerts?|automated|newsletters?|receipts?|billing|support|help|sales|orders?|marketing|campaigns?|security|news|payments?)(?:[+._-]|$)/i.exec(local) || /^(?:noreply|notification|newsletter)\./i.exec(domain)
  const label = authored.flatMap(message => (message.labels || []).map(value => ({ value:value.toLowerCase(), id:message.id }))).find(({value}) => /^(friends?|family|colleagues?|co-?workers?)$/.test(value))
  if (serviceRole) {
    relationship = 'services'; source = 'suggested'
    role = /billing|receipts?|payment/i.test(serviceRole[0]) ? 'Billing & receipts' : /support|help/i.test(serviceRole[0]) ? 'Customer support' : /sales/i.test(serviceRole[0]) ? 'Sales enquiries' : /orders?/i.test(serviceRole[0]) ? 'Order updates' : /newsletter|marketing|campaign|news/i.test(serviceRole[0]) ? 'News & marketing' : /security/i.test(serviceRole[0]) ? 'Account security' : 'Automated notifications'
    evidence.push({ reason:`Service address: ${node.email}`, messageId:authored[0]?.id })
  } else if (label) {
    relationship = /^friend/.test(label.value) ? 'friends' : label.value === 'family' ? 'family' : 'colleagues'; source = 'suggested'
    evidence.push({ reason:`Mailbox label: ${label.value}`, messageId:label.id })
  } else if (corporate && domain === self?.split('@')[1]) {
    relationship = 'colleagues'; source = 'suggested'; evidence.push({ reason:`Shares your email domain: ${domain}` })
  } else if (corporate) {
    relationship = 'company'; source = 'suggested'; evidence.push({ reason:`Organization domain: ${domain}` })
  }
  // Only first-person role statements authored by this address count as evidence.
  const statement = authored.map(message => ({ message, match:/(?:^|[.!?]\s+)(?:Hi[,!]?\s+)?I(?:\s+am|'m|’m)\s+(?:the\s+)?(?:responsible for|in charge of|your contact for)\s+([^.!?\n]{3,160})/i.exec(message.snippet || '') })).find(item => item.match)
  if (statement) { role = statement.match[1].trim(); evidence.push({ reason:`Sender states: ${statement.match[0].trim()}`, messageId:statement.message.id }) }
  if (saved.relationship !== 'auto') relationship = saved.relationship
  if (saved.company) company = saved.company
  if (saved.role) role = saved.role
  if (saved.relationship !== 'auto' || saved.company || saved.role) { source = 'confirmed'; evidence.unshift({ reason:'Contact details saved by you' }) }
  return { relationship, relationshipLabel:relationshipLabels[relationship], company, role, roleSource:saved.role ? 'confirmed' : statement ? 'sender_statement' : serviceRole ? 'address' : 'unknown', contextSource:source, evidence:evidence.slice(0,5), profile:saved }
}
