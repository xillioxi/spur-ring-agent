// Shared narrow allowlist. Gateways still resolve identity and credentials themselves.
export const PREFIX = '/api/creator-agent/business'
const KINDS = 'clients|leads|projects|tasks|finances|events|services|portfolio|proposals|deliverables|opportunities'
export const recordPath = new RegExp(`^${PREFIX}/records/(${KINDS})(?:/([a-f0-9]{32})(/archive)?)?$`)
export const conversionPath = new RegExp(`^${PREFIX}/leads/([a-f0-9]{32})/convert$`)
export const csvPath = new RegExp(`^${PREFIX}/export/(${KINDS})\\.csv$`)
export function allowedBusinessRoute(path, method) {
  if (['GET', 'HEAD'].includes(method)) {
    const record = recordPath.exec(path)
    return Boolean(record && !record[3]) || Boolean(csvPath.test(path)) ||
      ['modules','settings','schemas','dashboard','calendar','action-center','activity','export','tools'].some(name => path === `${PREFIX}/${name}`)
  }
  if (method === 'PUT') return ['modules','settings'].some(name => path === `${PREFIX}/${name}`)
  const record = recordPath.exec(path)
  if (method === 'PATCH') return Boolean(record?.[2] && !record[3])
  if (method === 'POST') return Boolean(record && (!record[2] || record[3])) || conversionPath.test(path) || path === `${PREFIX}/execute`
  return false
}
