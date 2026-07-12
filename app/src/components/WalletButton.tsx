"use client";

// Wallet trigger button — opens the custom right-side WalletDrawer instead
// of wallet-adapter's default modal. Keeps the same export name as the old
// WalletMultiButton wrapper, so every call site (nav, panels, portfolio,
// quick-trade modal) got the drawer for free.

import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletDrawer } from "./WalletDrawer";

function shortAddr(a: string): string {
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}

export function WalletButton() {
  const { connected, connecting, publicKey, wallet } = useWallet();
  const [open, setOpen] = useState(false);
  // Render nothing wallet-specific until mounted (SSR/first-paint parity).
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <>
      <button type="button" className="button" onClick={() => setOpen(true)} data-testid="wallet-button">
        {mounted && connected && publicKey ? (
          <>
            {wallet && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={wallet.adapter.icon} alt="" width={18} height={18} style={{ borderRadius: 5, marginRight: 6 }} />
            )}
            <span className="mono" style={{ fontSize: "0.85rem" }}>{shortAddr(publicKey.toBase58())}</span>
          </>
        ) : mounted && connecting ? (
          "Connecting…"
        ) : (
          "Connect Wallet"
        )}
      </button>
      <WalletDrawer open={open} onClose={() => setOpen(false)} />
    </>
  );
}
