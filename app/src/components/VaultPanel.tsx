"use client";

// The Vault — one non-custodial view of "your money" across the product:
// wallet balance, funds working inside markets (per-market program-owned
// escrow under the hood), 1-click trading status, and funding actions.
// ONYX never holds user funds: escrow accounts are owned by the on-chain
// program, the browser's trading key can only trade, and withdrawing always
// requires the user's wallet signature.

import { useMemo, useState } from "react";
import Link from "next/link";
import { useWallet } from "@solana/wallet-adapter-react";
import { useAmmPositionsForOwner, useAmmPoolMarkets } from "@/lib/hooks";
import { spotPriceScaled } from "@/lib/ammMath";
import { loadSession } from "@/lib/session";
import { CLUSTER } from "@/lib/ammActions";
import { Modal } from "./Modal";
import { FundingModal, useWalletFunds } from "./FundingModal";
import styles from "./FundingModal.module.css";

const fmt = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 2 });

export function VaultPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { publicKey } = useWallet();
  const { sol, usdc } = useWalletFunds(open);
  const [fundingOpen, setFundingOpen] = useState(false);

  const positions = useAmmPositionsForOwner(open ? publicKey : null);
  const marketPdas = useMemo(() => (positions.data ?? []).map((p) => p.market), [positions.data]);
  const pools = useAmmPoolMarkets(open && marketPdas.length > 0 ? marketPdas : undefined);

  // Funds at work: escrowed deposits + tokens valued at each pool's live price.
  const inMarkets = useMemo(() => {
    let total = 0n;
    for (const p of positions.data ?? []) {
      total += p.usdcAvailable;
      const pool = pools.data?.get(p.market);
      if (pool && pool.reserveA + pool.reserveB > 0n) {
        const priceA = spotPriceScaled(pool.reserveA, pool.reserveB);
        total += (p.tokensA * priceA + p.tokensB * (1_000_000n - priceA)) / 1_000_000n;
      }
    }
    return Number(total) / 1e6;
  }, [positions.data, pools.data]);

  const session = publicKey ? loadSession(CLUSTER, publicKey) : null;
  const sessionLive = session !== null && session.expiry * 1000 > Date.now();

  return (
    <>
      <Modal open={open} onClose={onClose} title="Vault">
        {publicKey ? (
          <>
            <div className={styles.balances}>
              <div>
                <span className={styles.balValue}>{usdc === null ? "…" : fmt(usdc)}</span>
                <span className={styles.balLabel}>in wallet (devnet USDC)</span>
              </div>
              <div>
                <span className={styles.balValue}>{positions.isPending ? "…" : fmt(inMarkets)}</span>
                <span className={styles.balLabel}>working in markets</span>
              </div>
              <div>
                <span className={styles.balValue}>{sol === null ? "…" : sol.toFixed(3)}</span>
                <span className={styles.balLabel}>SOL</span>
              </div>
            </div>

            <p className={styles.hint} style={{ marginBottom: 12 }}>
              {sessionLive ? (
                <>
                  <span style={{ color: "var(--green)" }}>● 1-click trading is on</span> until{" "}
                  {new Date(session!.expiry * 1000).toLocaleTimeString()} — trades need no approval. Withdrawals
                  always need your wallet.
                </>
              ) : (
                <>1-click trading is off — enable it on any market when you add funds.</>
              )}
            </p>

            <div className={styles.action} style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" className="button" onClick={() => setFundingOpen(true)}>
                Add funds
              </button>
              <Link href="/portfolio" className="button" data-variant="ghost" onClick={onClose}>
                Positions &amp; withdrawals →
              </Link>
            </div>

            <p className={styles.explainer}>
              <strong>Non-custodial:</strong> money you add to a market sits in that market&apos;s on-chain
              escrow, owned by the program — never by ONYX. Selling or winning moves it back where your wallet
              can withdraw it (the Portfolio lists everything redeemable). The trading key in your browser can
              only trade; it mathematically cannot withdraw.
            </p>
          </>
        ) : (
          <p className="muted">Connect a wallet to see your vault.</p>
        )}
      </Modal>
      <FundingModal open={fundingOpen} onClose={() => setFundingOpen(false)} />
    </>
  );
}
