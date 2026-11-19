import { useEffect, useRef, useState } from 'react'
import type { Core } from 'cytoscape'
import type { EmailNetwork } from './emailMemoryApi'

export default function EmailNetworkGraph({ network, selectedEmail, onSelect }: { network: EmailNetwork; selectedEmail: string; onSelect: (email: string) => void }) {
  const element = useRef<HTMLDivElement>(null), graph = useRef<Core | null>(null), select = useRef(onSelect), selection = useRef(selectedEmail)
  const [error, setError] = useState('')
  select.current = onSelect
  selection.current = selectedEmail
  useEffect(() => {
    if (!element.current || !network.nodes.length) return
    let stopped = false, observer: ResizeObserver | undefined, instance: Core | undefined
    setError('')
    void import('cytoscape').then(({ default: cytoscape }) => {
      if (stopped || !element.current) return
      instance = cytoscape({ container: element.current, elements: [
        ...network.nodes.map(node => ({ data: { id: node.id, email: node.email, label: node.kind === 'self' ? 'You' : node.label, kind: node.kind, size: Math.min(55, 21 + Math.log1p(node.messageCount) * 6) } })),
        ...network.edges.map(edge => ({ data: { id: edge.id, source: edge.source, target: edge.target, width: Math.min(5, .6 + Math.log1p(edge.weight) * .7) } })),
      ], style: [
        { selector: 'node', style: { 'background-color': '#b2bb9e', width: 'data(size)', height: 'data(size)', label: 'data(label)', color: '#56634c', 'font-size': 10, 'text-valign': 'bottom', 'text-margin-y': 7, 'text-max-width': '100px', 'text-wrap': 'ellipsis', 'border-width': 2, 'border-color': '#f8f8f3' } },
        { selector: 'node[kind = "self"]', style: { 'background-color': '#72835d', 'border-width': 4, 'border-color': '#e5e8dc', color: '#43513a', 'font-weight': 'bold' } },
        { selector: 'edge', style: { width: 'data(width)', 'line-color': '#d9ddcf', 'target-arrow-color': '#c4cbb7', 'target-arrow-shape': 'triangle', 'arrow-scale': .65, 'curve-style': 'bezier', opacity: .65 } },
        { selector: 'node.focused', style: { 'background-color': '#435739', 'border-color': '#d8dfc7', 'border-width': 5, color: '#293d26', 'font-weight': 'bold' } },
      ], layout: { name: 'cose', animate: false, randomize: false, fit: true, padding: 40, nodeRepulsion: () => 7000, idealEdgeLength: () => 85, numIter: 450 }, minZoom: .15, maxZoom: 3, wheelSensitivity: .2 })
      graph.current = instance
      instance.nodes().filter(node => node.data('email') === selection.current).addClass('focused')
      instance.on('tap', 'node', event => select.current(event.target.data('kind') === 'self' ? '' : event.target.data('email')))
      if (typeof ResizeObserver !== 'undefined') { observer = new ResizeObserver(() => instance?.resize()); observer.observe(element.current) }
    }).catch(() => { if (!stopped) setError('The network could not be drawn. You can still browse every person in the list.') })
    return () => { stopped = true; observer?.disconnect(); instance?.destroy(); if (graph.current === instance) graph.current = null }
  }, [network])
  useEffect(() => {
    const instance = graph.current
    if (!instance) return
    instance.nodes().removeClass('focused')
    instance.nodes().filter(node => node.data('email') === selectedEmail).addClass('focused')
  }, [selectedEmail, network])
  return <div className="email-network-canvas-wrap">
    <div ref={element} className="email-network-canvas" role="img" aria-label="Email communication network. Select a person in the list below to read their messages." />
    <div className="email-network-map-controls"><button type="button" onClick={() => graph.current?.fit(undefined, 40)}>Fit network</button><span>Drag to explore · select a person</span></div>
    {error && <p role="status" className="email-memory-error">{error}</p>}
  </div>
}
