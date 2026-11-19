import type { CSSProperties, ReactNode } from 'react';

export type IconName = 'brand' | 'mic' | 'ring' | 'library' | 'settings' | 'arrow' | 'chevron' | 'copy' | 'download' | 'folder' | 'check' | 'close' | 'minus' | 'play' | 'stop' | 'refresh' | 'bluetooth' | 'bolt' | 'speech' | 'eye' | 'eyeoff' | 'info' | 'trash' | 'search' | 'cursor' | 'cloud' | 'shield';

const paths: Record<IconName, ReactNode> = {
  brand: <><path d="M12 2.6c0 5.2-3.2 8.4-8.4 8.4 5.2 0 8.4 3.2 8.4 8.4 0-5.2 3.2-8.4 8.4-8.4-5.2 0-8.4-3.2-8.4-8.4Z"/><path d="m19 2 .7 2.3L22 5l-2.3.7L19 8l-.7-2.3L16 5l2.3-.7L19 2Z" fill="currentColor" stroke="none"/></>,
  mic: <><rect x="9" y="2.5" width="6" height="12" rx="3"/><path d="M5.5 10.5V12a6.5 6.5 0 0 0 13 0v-1.5M12 18.5V22m-3 0h6"/></>,
  ring: <><ellipse cx="12" cy="12" rx="8.5" ry="9.5"/><ellipse cx="12" cy="12" rx="5" ry="6.2"/><path d="m6.5 4.8 2 2.1m9-2.1-2 2.1"/></>,
  library: <><rect x="4" y="3" width="16" height="18" rx="3"/><path d="M8 8h8M8 12h8m-8 4h5"/></>,
  settings: <><path d="m9.4 3-.6 2.3-2 .9L4.6 5.5 2 10l1.7 1.7v2.4L2 15.8l2.6 4.5 2.2-.7 2 .9.6 2.3h5.2l.6-2.3 2-.9 2.2.7 2.6-4.5-1.7-1.7v-2.4L22 10l-2.6-4.5-2.2.7-2-.9L14.6 3Z" transform="translate(0 -1) scale(1 .96)"/><circle cx="12" cy="12" r="3.2"/></>,
  arrow: <><path d="M4 12h15m-5-5 5 5-5 5"/></>,
  chevron: <path d="m9 5 7 7-7 7"/>,
  copy: <><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M15 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3"/></>,
  download: <><path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4"/></>,
  folder: <><path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M3 9h18"/></>,
  check: <path d="m5 12 4 4L19 6"/>,
  close: <path d="m6 6 12 12M18 6 6 18"/>,
  minus: <path d="M5 12h14"/>,
  play: <path d="m9 5 11 7-11 7Z" fill="currentColor" stroke="none"/>,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>,
  refresh: <><path d="M20 8a8.5 8.5 0 0 0-15-2L2 9m0-6v6h6m-4 7a8.5 8.5 0 0 0 15 2l3-3m0 6v-6h-6"/></>,
  bluetooth: <path d="m6 7 12 10-6 5V2l6 5L6 17"/>,
  bolt: <path d="m13 2-9 12h7l-1 8 10-13h-7Z"/>,
  speech: <><path d="M4 4h16v13H9l-5 4Z"/><path d="M8 8h8m-8 4h5"/></>,
  eye: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></>,
  eyeoff: <><path d="M4 7c-1.3 1.4-2 3-2 3s3.5 7 10 7c1.8 0 3.4-.5 4.8-1.3M8 3.7c1.2-.5 2.5-.7 4-.7 6.5 0 10 7 10 7a20 20 0 0 1-2.7 3.8M3 1l18 20"/><path d="M9.9 7.9a3 3 0 0 0 4.2 4.2"/></>,
  info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.2"/></>,
  trash: <><path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
  cursor: <path d="m5 3 15 9-7 2-3 7Z"/>,
  cloud: <path d="M6 18a5 5 0 0 1-1.3-9.8A7.5 7.5 0 0 1 19 7a5.5 5.5 0 0 1-1 11H6Z"/>,
  shield: <><path d="m12 2 8 3v6c0 5-8 10-8 10s-8-5-8-10V5Z"/><path d="m8 11 3 3 5-5"/></>,
};

export function Icon({ name, size = 20, className, style }: { name: IconName; size?: number; className?: string; style?: CSSProperties }) {
  return <svg className={className} style={style} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}
