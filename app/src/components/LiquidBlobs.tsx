// Decorative liquid-glass background: a few soft, gooey blobs drifting
// slowly behind the hero content, seen through the frosted glass panel.
// Pure SVG + CSS animation (server component, zero JS) — the goo filter is
// feGaussianBlur+feColorMatrix (cheap, well-supported), NOT the heavier
// feTurbulence/feDisplacementMap backdrop-filter trick used by LiquidButton;
// that combination is reserved for small interactive elements (see
// liquid-glass-button.tsx header note) because running it across a
// hero-sized area is expensive and has patchy Safari support for
// backdrop-filter: url(#svg-filter). Single accent hue only, at varying
// opacity — deliberately not a second competing color.

import styles from "./LiquidBlobs.module.css";

export function LiquidBlobs() {
  return (
    <svg
      className={styles.field}
      viewBox="0 0 1000 560"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      <defs>
        <filter id="onyx-goo" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="15" result="b" />
          <feColorMatrix
            in="b"
            mode="matrix"
            values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 22 -9"
          />
        </filter>
      </defs>
      <g filter="url(#onyx-goo)">
        <circle className={styles.blobA} cx="190" cy="160" r="160" />
        <circle className={styles.blobB} cx="770" cy="110" r="130" />
        <circle className={styles.blobC} cx="630" cy="410" r="145" />
      </g>
    </svg>
  );
}
