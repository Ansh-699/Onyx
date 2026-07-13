// LiquidButton port (21st.dev-style liquid-glass): transparent button whose
// backdrop layer refracts the page through an SVG turbulence-displacement
// filter, under a rounded-full inset-shadow rim layer. Exact shadow/filter
// values from the reference component; Tailwind classes translated to the
// CSS module (no tailwind/cva/radix deps for one button).

import Link from "next/link";
import styles from "./ChromeCta.module.css";

export interface ChromeCtaProps {
  href: string;
  label?: string;
}

export function ChromeCta({ href, label = "Launch App" }: ChromeCtaProps) {
  return (
    <Link href={href} className={styles.liquidBtn} data-testid="chrome-cta">
      {/* rim: the inset-shadow stack (reference's rounded-full overlay) */}
      <span className={styles.rim} aria-hidden />
      {/* glass: refracts what's behind through the displacement filter */}
      <span className={styles.glass} aria-hidden />
      <span className={styles.label}>{label}</span>

      <svg className={styles.filterDefs} aria-hidden>
        <defs>
          <filter id="onyx-container-glass" x="0%" y="0%" width="100%" height="100%" colorInterpolationFilters="sRGB">
            <feTurbulence type="fractalNoise" baseFrequency="0.05 0.05" numOctaves="1" seed="1" result="turbulence" />
            <feGaussianBlur in="turbulence" stdDeviation="2" result="blurredNoise" />
            <feDisplacementMap in="SourceGraphic" in2="blurredNoise" scale="70" xChannelSelector="R" yChannelSelector="B" result="displaced" />
            <feGaussianBlur in="displaced" stdDeviation="4" result="finalBlur" />
            <feComposite in="finalBlur" in2="finalBlur" operator="over" />
          </filter>
        </defs>
      </svg>
    </Link>
  );
}
