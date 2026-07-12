"use client";

import Link from "next/link";
import { useState } from "react";
import { usePathname } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletUsdc } from "@/lib/hooks";
import { WalletButton } from "./WalletButton";
import { ThemeToggle } from "./ThemeToggle";
import { VaultPanel } from "./VaultPanel";
import { FundingModal } from "./FundingModal";
import styles from "./Nav.module.css";

const LINKS = [
  { href: "/markets", label: "Markets" },
  { href: "/leaderboard", label: "Leaderboard" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/how-to-trade", label: "How to trade" },
];

export function Nav() {
  const pathname = usePathname();
  const { connected, publicKey } = useWallet();
  const [vaultOpen, setVaultOpen] = useState(false);
  const [faucetOpen, setFaucetOpen] = useState(false);
  const usdc = useWalletUsdc(connected ? publicKey : null);
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
        <button type="button" className={styles.navBtn} onClick={() => setFaucetOpen(true)}>
          Faucet
        </button>
      </nav>
      <div className={styles.wallet}>
        <ThemeToggle />
        {connected && (
          <button type="button" className="button" data-variant="ghost" onClick={() => setVaultOpen(true)} data-testid="nav-vault">
            Vault
            <span className={styles.balanceChip}>
              ${usdc.data === undefined ? "…" : usdc.data.toLocaleString(undefined, { maximumFractionDigits: 2 })}
            </span>
          </button>
        )}
        <WalletButton />
      </div>
      <VaultPanel open={vaultOpen} onClose={() => setVaultOpen(false)} />
      <FundingModal open={faucetOpen} onClose={() => setFaucetOpen(false)} />
    </header>
  );
}
