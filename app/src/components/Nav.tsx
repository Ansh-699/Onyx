"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { WalletButton } from "./WalletButton";
import { ThemeToggle } from "./ThemeToggle";
import styles from "./Nav.module.css";

const LINKS = [
  { href: "/markets", label: "Markets" },
  { href: "/create", label: "Create" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/demo/mev", label: "Why sealed?" },
];

export function Nav() {
  const pathname = usePathname();
  return (
    <header className={styles.nav}>
      <div className={styles.brand}>
        <Link href="/" className={styles.logo}>
          ONYX
        </Link>
        <span className={styles.badge}>devnet</span>
      </div>
      <nav className={styles.links}>
        {LINKS.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            data-active={pathname === l.href || (l.href !== "/" && pathname.startsWith(l.href + "/")) || (l.href === "/markets" && pathname.startsWith("/market/"))}
          >
            {l.label}
          </Link>
        ))}
      </nav>
      <div className={styles.wallet}>
        <ThemeToggle />
        <WalletButton />
      </div>
    </header>
  );
}
