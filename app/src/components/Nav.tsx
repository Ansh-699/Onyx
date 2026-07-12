"use client";

import Link from "next/link";
import { useState } from "react";
import { usePathname } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletButton } from "./WalletButton";
import { ThemeToggle } from "./ThemeToggle";
import { VaultPanel } from "./VaultPanel";
import styles from "./Nav.module.css";

const LINKS = [
  { href: "/markets", label: "Markets" },
  { href: "/create", label: "Create" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/demo/mev", label: "Why sealed?" },
];

export function Nav() {
  const pathname = usePathname();
  const { connected } = useWallet();
  const [vaultOpen, setVaultOpen] = useState(false);
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
        {connected && (
          <button type="button" className="button" data-variant="ghost" onClick={() => setVaultOpen(true)} data-testid="nav-vault">
            Vault
          </button>
        )}
        <WalletButton />
      </div>
      <VaultPanel open={vaultOpen} onClose={() => setVaultOpen(false)} />
    </header>
  );
}
