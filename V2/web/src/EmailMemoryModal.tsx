import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** A centered account popup. The portal keeps the dialog outside the inert app. */
export function EmailMemoryModal({ title, busy = false, onClose, children }: { title: string; busy?: boolean; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLElement>(null), close = useRef(onClose), pending = useRef(busy)
  close.current = onClose; pending.current = busy
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow, app = document.getElementById('root'), wasInert = app?.hasAttribute('inert')
    document.body.style.overflow = 'hidden'; app?.setAttribute('inert', '')
    const initial = dialog.current?.querySelector<HTMLElement>('[data-mailbox-autofocus]')
    ;(initial || dialog.current)?.focus()
    function keys(event: KeyboardEvent) {
      const container = dialog.current
      if (!container) return
      if (event.key === 'Escape') { event.preventDefault(); if (!pending.current) close.current(); return }
      if (event.key !== 'Tab') return
      const focusable = [...container.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])')].filter(element => element.getClientRects().length > 0 && !element.closest('[hidden],[inert]'))
      const first = focusable[0], last = focusable[focusable.length - 1], active = document.activeElement
      if (!first) { event.preventDefault(); container.focus(); return }
      if (event.shiftKey && (active === first || active === container || !container.contains(active))) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (active === last || !container.contains(active))) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', keys)
    return () => {
      document.removeEventListener('keydown', keys); document.body.style.overflow = overflow
      if (!wasInert) app?.removeAttribute('inert')
      if (previous?.isConnected) previous.focus()
    }
  }, [])
  const content = <div className="email-memory-modal-layer">
    <button type="button" tabIndex={-1} className="email-memory-modal-backdrop" aria-label="Close account popup" disabled={busy} onClick={() => { if (!busy) onClose() }} />
    <section ref={dialog} className="email-memory-modal" role="dialog" aria-modal="true" aria-label={title} aria-busy={busy || undefined} tabIndex={-1}>
      {children}
    </section>
  </div>
  return typeof document === 'undefined' ? content : createPortal(content, document.body)
}
