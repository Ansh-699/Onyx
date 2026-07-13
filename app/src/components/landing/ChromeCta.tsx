// Soft frosted liquid-glass CTA (Beta-Access style): transparent to the
// hero's blue behind it — big blurred top bloom, soft white rim, deep-blue
// bottom inner shadow. All CSS; see ChromeCta.module.css.

import Link from "next/link";
import styles from "./ChromeCta.module.css";

export interface ChromeCtaProps {
  href: string;
  label?: string;
}

export function ChromeCta({ href, label = "Launch App" }: ChromeCtaProps) {
  return (
    <Link href={href} className={styles.glassBtn} data-testid="chrome-cta">
      <span className={styles.glassLabel}>{label}</span>
    </Link>
  );
}
