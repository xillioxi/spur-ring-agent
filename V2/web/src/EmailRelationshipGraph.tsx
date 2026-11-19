import { useEffect, useRef, useState } from 'react'
import type { Core, ElementDefinition } from 'cytoscape'
import type { EmailNetwork } from './emailMemoryApi'

const groups = [ ['colleagues', 'Colleagues'], ['friends', 'Friends'], ['family', 'Family'], ['services', 'Services'], ['company', 'Companies'], ['other', 'Other contacts'] ] as const
const colors: Record<string, string> = { colleagues:'#809bba', friends:'#b58ba8', family:'#c9a469', services:'#94a67d', company:'#79a9a3', other:'#aaa89f' }

export default function EmailRelationshipGraph({ network, selectedEmail, onSelect, onCompany }: { network: EmailNetwork; selectedEmail: string; onSelect: (email: string) => void; onCompany: (company: string) => void }) {
  const element = useRef<HTMLDivElement>(null), graph = useRef<Core | null>(null), select = useRef(onSelect), selection = useRef(selectedEmail)
  const [error, setError] = useState(''), [showTraffic, setShowTraffic] = useState(false)
  const companySelect = useRef(onCompany); companySelect.current = onCompany
  select.current = onSelect; selection.current = selectedEmail
  useEffect(() => {
    if (!element.current || !network.nodes.length) return
    let stopped = false, observer: ResizeObserver | undefined, instance: Core | undefined
    setError('')
    void import('cytoscape').then(({ default: cytoscape }) => {
      if (stopped || !element.current) return
      const elements: ElementDefinition[] = [], people = network.nodes.filter(node => node.kind !== 'self')
      let groupIndex = 0, y = 100, rowHeight = 0
      for (const [key, title] of groups) {
        const members = people.filter(node => (node.relationship || 'other') === key)
        if (!members.length) continue
        if (groupIndex && groupIndex % 3 === 0) { y += rowHeight + 100; rowHeight = 0 }
        const x = (groupIndex % 3) * 620, parent = `group:${key}`
        elements.push({ data:{ id:parent, label:`${title} · ${members.length}`, kind:'group', color:colors[key] } })
        const companies = new Map<string, typeof members>()
        for (const person of members) { const company = person.company || ''; if (!companies.has(company)) companies.set(company, []); companies.get(company)!.push(person) }
        let offset = 0, summaryIndex = 0
        for (const [company, contacts] of companies) {
          if (people.length > 40 && company) {
            elements.push({ data:{ id:`summary:${JSON.stringify([key,company])}`, parent, label:`${company}\n${contacts.length} contacts · open`, kind:'summary', company, color:colors[key], size:42 }, position:{ x:x + summaryIndex % 3 * 170, y:y + Math.floor(summaryIndex / 3) * 105 } })
            summaryIndex++; continue
          }
          if (people.length > 40) {
            for (const node of contacts) { elements.push({ data:{ id:node.id,email:node.email,parent,label:`${node.label}\n${node.role || 'Role unknown'}`,kind:'person',color:colors[key],size:30 },position:{ x:x + summaryIndex % 3 * 170,y:y + Math.floor(summaryIndex / 3) * 105 } });summaryIndex++ }
            continue
          }
          const companyId = company ? `company:${JSON.stringify([key, company])}` : parent
          if (company) elements.push({ data:{ id:companyId, parent, label:company, kind:'company', color:colors[key] } })
          contacts.forEach((node, index) => elements.push({ data:{ id:node.id, email:node.email, parent:companyId, label:`${node.label}\n${node.role || 'Role unknown'}`, kind:'person', color:colors[key], size:Math.min(45, 24 + Math.log1p(node.messageCount) * 3) }, position:{ x:x + index % 3 * 170, y:y + offset + Math.floor(index / 3) * 105 } }))
          offset += Math.ceil(contacts.length / 3) * 105 + 65
        }
        rowHeight = Math.max(rowHeight, offset, Math.ceil(summaryIndex / 3) * 105); groupIndex++
      }
      for (const node of network.nodes.filter(node => node.kind === 'self')) elements.push({ data:{ id:node.id, email:node.email, label:'You', kind:'self', color:'#72835d', size:50 }, position:{ x:490,y:-90 } })
      const renderedIds = new Set(elements.map(element => element.data.id))
      for (const edge of network.edges) if (renderedIds.has(edge.source) && renderedIds.has(edge.target)) elements.push({ data:{ id:edge.id, source:edge.source, target:edge.target, width:Math.min(4, .6 + Math.log1p(edge.weight) * .7) } })
      instance = cytoscape({ container:element.current, elements, style:[
        { selector:'node', style:{ 'background-color':'data(color)', width:30, height:30, label:'data(label)', color:'#43513a', 'font-size':11, 'text-valign':'bottom', 'text-margin-y':7, 'text-max-width':'145px', 'text-wrap':'wrap', 'border-width':2, 'border-color':'#f8f8f3' } },
        { selector:'node[kind = "person"], node[kind = "self"], node[kind = "summary"]', style:{ width:'data(size)', height:'data(size)' } },
        { selector:'node[kind = "group"]', style:{ 'background-opacity':.08, 'border-color':'data(color)', 'border-width':2, shape:'round-rectangle', padding:'28px', 'text-valign':'top', 'text-halign':'left', 'text-margin-x':10, 'text-margin-y':-12, 'font-size':18, 'font-weight':'bold', 'text-max-width':'500px' } },
        { selector:'node[kind = "company"]', style:{ 'background-opacity':.06, 'border-color':'data(color)', 'border-width':1, shape:'round-rectangle', padding:'24px', 'text-valign':'top', 'text-margin-y':-8, 'font-size':12, 'text-max-width':'400px' } },
        { selector:'edge', style:{ display:showTraffic ? 'element' : 'none', width:'data(width)', 'line-color':'#b5bbaa', 'target-arrow-color':'#b5bbaa', 'target-arrow-shape':'triangle', 'arrow-scale':.65, 'curve-style':'bezier', opacity:.35 } },
        { selector:'node.focused', style:{ 'border-color':'#435739', 'border-width':5, color:'#293d26', 'font-weight':'bold' } },
      ], layout:{ name:'preset', fit:true, padding:50 }, minZoom:.05, maxZoom:3, wheelSensitivity:.2 })
      graph.current = instance
      instance.nodes().filter(node => node.data('email') === selection.current).addClass('focused')
      instance.on('tap', 'node', event => { const node = event.target; if (node.data('kind') === 'summary') companySelect.current(node.data('company')); else if (node.data('email')) select.current(node.data('kind') === 'self' ? '' : node.data('email')) })
      if (typeof ResizeObserver !== 'undefined') { observer = new ResizeObserver(() => instance?.resize()); observer.observe(element.current) }
    }).catch(() => { if (!stopped) setError('The network could not be drawn. You can still browse every person in the list.') })
    return () => { stopped = true; observer?.disconnect(); instance?.destroy(); if (graph.current === instance) graph.current = null }
  }, [network, showTraffic])
  useEffect(() => { const instance = graph.current; if (instance) { instance.nodes().removeClass('focused'); instance.nodes().filter(node => node.data('email') === selectedEmail).addClass('focused') } }, [selectedEmail, network])
  return <div className="email-network-canvas-wrap">
    <div ref={element} className="email-network-canvas" role="img" aria-label="Contacts organized by relationship and company. Use the contact list below to select a person and review their responsibilities." />
    <div className="email-network-map-controls"><button type="button" onClick={() => graph.current?.fit(undefined, 50)}>Fit network</button><label><input type="checkbox" checked={showTraffic} onChange={event => setShowTraffic(event.target.checked)} /> Show email activity</label><span>Groups → companies → people</span></div>
    {error && <p role="status" className="email-memory-error">{error}</p>}
  </div>
}
