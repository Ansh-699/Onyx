"use client";

import Link from "next/link";
import Image from "next/image";
import { useState } from "react";
import { usePathname } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import gemDark from "@/assets/onyx-gem.png";
import gemLight from "@/assets/onyx-gem-light.png";
import { useWalletUsdc } from "@/lib/hooks";
import { WalletButton } from "./WalletButton";
import { ThemeToggle } from "./ThemeToggle";
import { VaultPanel } from "./VaultPanel";
import { FundingModal } from "./FundingModal";
import styles from "./Nav.module.css";

const LINKS = [
  { href: "/markets", label: "Markets" },
  { href: "/create", label: "Create" },
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
  // The landing is a full-bleed marketing surface (its own wordmark, its own
  // nav pill) — the app chrome would break the hero, so it opts out.
  if (pathname === "/") return null;
  return (
    <header className={styles.nav}>
      <div className={styles.brand}>
        <Link href="/" className={styles.logo}>
          {/* theme-paired gems: dark gem on the light theme, light gem on
              dark — CSS swaps them from the root data-theme attribute */}
          <Image src={gemDark} alt="" width={22} height={22} className={styles.gemOnLight} />
          <Image src={gemLight} alt="" width={22} height={22} className={styles.gemOnDark} />
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
        {connected &&
          (usdc.data === 0 ? (
            // empty wallet: one clear call-to-action instead of "Vault $0"
            <button type="button" className={styles.depositNav} onClick={() => setFaucetOpen(true)} data-testid="nav-deposit">
              Deposit
            </button>
          ) : (
            <button type="button" className="button" data-variant="ghost" onClick={() => setVaultOpen(true)} data-testid="nav-vault">
              Vault
              <span className={styles.balanceChip}>
                ${usdc.data === undefined ? "…" : usdc.data.toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </span>
            </button>
          ))}
        <WalletButton />
      </div>
      <VaultPanel open={vaultOpen} onClose={() => setVaultOpen(false)} />
      <FundingModal open={faucetOpen} onClose={() => setFaucetOpen(false)} />
    </header>
  );
}
