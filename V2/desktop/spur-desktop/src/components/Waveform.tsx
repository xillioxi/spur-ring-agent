import type { CSSProperties } from 'react';

const HEIGHTS = [9, 12, 18, 13, 26, 38, 21, 47, 34, 61, 42, 27, 55, 73, 49, 34, 65, 82, 55, 39, 68, 93, 60, 45, 73, 100, 72, 48, 67, 89, 60, 40, 69, 76, 53, 32, 61, 45, 28, 55, 36, 22, 43, 31, 18, 26, 15, 20, 12, 16, 9];

export function Waveform({ active, processing, level }: { active: boolean; processing: boolean; level: number }) {
  return <div className={`waveform${active ? ' is-listening' : ''}${processing ? ' is-processing' : ''}`} style={{ '--signal-level': Math.max(0.04, Math.min(1, Number.isFinite(level) ? level : 0)) } as CSSProperties} aria-hidden="true">
    {HEIGHTS.map((height, index) => <span key={index} style={{ '--bar-height': `${height}%`, '--bar-delay': `${index * -0.071}s`, '--bar-speed': `${0.5 + (index % 7) * 0.11}s` } as CSSProperties} />)}
  </div>;
}
