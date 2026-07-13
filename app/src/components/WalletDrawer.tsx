"use client";

// Custom right-side Connect Wallet drawer replacing wallet-adapter's default
// modal: Recently-used section, wallet grid with adapter icons, connected
// state with copy/explorer/disconnect. Portaled to document.body (glass
// ancestors trap position:fixed — same lesson as Modal.tsx).

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useWallet, type Wallet } from "@solana/wallet-adapter-react";
import type { WalletName } from "@solana/wallet-adapter-base";
import { explorerAddressUrl } from "@/lib/onchain";
import styles from "./WalletDrawer.module.css";

const LAST_WALLET_KEY = "onyx:lastWallet";

function shortAddr(a: string): string {
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}

export function WalletDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { wallets, select, connected, connecting, publicKey, disconnect, wallet } = useWallet();
  const [error, setError] = useState<string | null>(null);
  const [lastUsed, setLastUsed] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (open) {
      setError(null);
      setLastUsed(localStorage.getItem(LAST_WALLET_KEY));
      document.body.style.overflow = "hidden";
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") onClose();
      };
      window.addEventListener("keydown", onKey);
      return () => {
        document.body.style.overflow = "";
        window.removeEventListener("keydown", onKey);
      };
    }
  }, [open, onClose]);

  // Close automatically when a connection lands — but only if the drawer was
  // opened DISCONNECTED. `open && connected` alone also matches "opened while
  // already connected", which auto-closed the connected view 600ms after
  // every open (looked like the drawer flashing and vanishing).
  const openedConnected = useRef(false);
  useEffect(() => {
    if (open) openedConnected.current = connected;
    // capture connection state at open time only — not when it changes later
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    if (open && connected && !openedConnected.current) {
      if (wallet) localStorage.setItem(LAST_WALLET_KEY, wallet.adapter.name);
      const t = setTimeout(onClose, 600);
      return () => clearTimeout(t);
    }
  }, [open, connected, wallet, onClose]);

  const pick = useCallback(
    (name: string) => {
      setError(null);
      try {
        localStorage.setItem(LAST_WALLET_KEY, name);
        select(name as WalletName); // autoConnect on the provider does the rest
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [select],
  );

  if (!open) return null;

  const installed = wallets.filter((w) => w.readyState === "Installed");
  const others = wallets.filter((w) => w.readyState !== "Installed");
  const recent = installed.filter((w) => w.adapter.name === lastUsed);
  const rest = [...installed.filter((w) => w.adapter.name !== lastUsed), ...others];

  const walletBtn = (w: Wallet) => (
    <button key={w.adapter.name} type="button" className={styles.walletBtn} onClick={() => pick(w.adapter.name)} disabled={connecting}>
      {/* adapter icons are data: URIs from the wallet packages, not remote fetches */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={w.adapter.icon} alt="" width={28} height={28} />
      <span>{w.adapter.name}</span>
      {w.readyState !== "Installed" && <span className={styles.notInstalled}>not installed</span>}
    </button>
  );

  return createPortal(
    <div className={styles.backdrop} onClick={onClose} role="presentation">
      <aside className={styles.drawer} role="dialog" aria-modal="true" aria-label="Connect wallet" onClick={(e) => e.stopPropagation()}>
        <div className={styles.head}>
          <span className={styles.title}>{connected ? "Wallet" : "Connect Wallet"}</span>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {connected && publicKey ? (
          <div className={styles.connectedBox}>
            <div className={styles.addrRow}>
              {wallet && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={wallet.adapter.icon} alt="" width={30} height={30} />
              )}
              <span className="mono">{shortAddr(publicKey.toBase58())}</span>
            </div>
            <div className={styles.connectedActions}>
              <button
                type="button"
                className="button"
                data-variant="ghost"
                onClick={() => {
                  void navigator.clipboard.writeText(publicKey.toBase58());
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1200);
                }}
              >
                {copied ? "Copied ✓" : "Copy address"}
              </button>
              <a className="button" data-variant="ghost" href={explorerAddressUrl(publicKey.toBase58())} target="_blank" rel="noreferrer">
                Explorer ↗
              </a>
              <button
                type="button"
                className="button"
                data-variant="danger"
                onClick={() => {
                  void disconnect();
                  onClose();
                }}
              >
                Disconnect
              </button>
            </div>
          </div>
        ) : (
          <>
            {recent.length > 0 && (
              <>
                <p className={styles.sectionLabel}>Recently used</p>
                <div className={styles.walletList}>{recent.map(walletBtn)}</div>
              </>
            )}
            <p className={styles.sectionLabel}>{recent.length > 0 ? "More wallets" : "Wallets"}</p>
            <div className={styles.walletList}>{rest.map(walletBtn)}</div>
            {connecting && <p className={styles.connecting}>Connecting… approve in your wallet.</p>}
            {error && <p className={styles.error}>{error}</p>}
            <p className={styles.footNote}>
              New to Solana wallets?{" "}
              <a href="https://phantom.com" target="_blank" rel="noreferrer">
                Learn more ↗
              </a>
            </p>
          </>
        )}
      </aside>
    </div>,
    document.body,
  );
}
