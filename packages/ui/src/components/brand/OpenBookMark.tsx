import {type CSSProperties} from 'react';

/**
 * The compact OpenBook mark: a clean open book on an accent tile, legible down
 * to favicon sizes (16px). A reduction of the full {@link OpenBookLogo}
 * constellation — same accent-as-cover behaviour (tile follows `--brand`), with
 * three "linked notes" dots nodding to the constellation. Used in the desktop
 * titlebar; its shape is also the source for the static favicon / OS icons.
 */

const themedVars: Record<string, string> = {
  '--cover': 'hsl(var(--brand, 207 76% 47%))',
  '--cover-deep': 'color-mix(in srgb, hsl(var(--brand, 207 76% 47%)) 70%, #000)',
};

export interface OpenBookMarkProps {
  size?: number | string;
  className?: string;
  style?: CSSProperties;
  title?: string | null;
  /** Tile corner radius in the 32-unit viewBox (default 7). */
  radius?: number;
}

export function OpenBookMark({size = 24, className, style, title = 'OpenBook', radius = 7}: OpenBookMarkProps) {
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      role={title ? 'img' : 'presentation'}
      aria-label={title || undefined}
      aria-hidden={title ? undefined : true}
      className={className}
      style={{...themedVars, ...style} as CSSProperties}
    >
      <rect width="32" height="32" rx={radius} fill="var(--cover, #1d7dd3)" />
      {/* Open book — white pages from a centre spine */}
      <path
        d="M16 9.6c-1.9-1.5-4.5-2.1-7.3-2.1-.4 0-.7.3-.7.7v12.6c0 .4.3.7.7.7 2.8 0 5.4.6 7.3 2.1 1.9-1.5 4.5-2.1 7.3-2.1.4 0 .7-.3.7-.7V8.2c0-.4-.3-.7-.7-.7-2.8 0-5.4.6-7.3 2.1z"
        fill="#fff"
        opacity="0.97"
      />
      <path d="M16 9.6v13.8" stroke="var(--cover, #1d7dd3)" strokeWidth="1.4" strokeLinecap="round" />
      {/* Linked-notes constellation on the right page */}
      <g fill="var(--cover-deep, #155f9f)">
        <circle cx="19.4" cy="12.4" r="1.15" />
        <circle cx="22.3" cy="14.3" r="1.15" />
        <circle cx="19.9" cy="16.6" r="1.15" />
      </g>
      <g stroke="var(--cover-deep, #155f9f)" strokeWidth="0.7" strokeOpacity="0.55">
        <line x1="19.4" y1="12.4" x2="22.3" y2="14.3" />
        <line x1="22.3" y1="14.3" x2="19.9" y2="16.6" />
      </g>
    </svg>
  );
}

export default OpenBookMark;
