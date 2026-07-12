"use client";

// The Vault — one non-custodial view of "your money" across the product:
// wallet balance, funds working inside markets, WITHDRAWABLE winnings with
// one-click withdraw buttons (each fires redeem_amm: the program pays your
// wallet's token account directly — there is deliberately no intermediate
// platform balance to claim from, because ONYX never holds user funds).
// The trading key in the browser can only trade; every withdrawal here is
// signed by the user's wallet.

import { useMemo, useState } from "react";
import Link from "next/link";
import { useWallet } from "@solana/wallet-adapter-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PublicKey, Transaction } from "@solana/web3.js";
import { useAmmPositionsForOwner, useAmmPoolMarkets } from "@/lib/hooks";
import {
  getMarket,
  getConnection,
  getConfigUsdcMint,
  STATUS_SETTLED,
  STATUS_CLAIMED,
  OUTCOME_SIDE_A,
  SETTLE_GRACE_SEC,
  type OnChainMarket,
} from "@/lib/onchain";
import { buildRedeemAmmIx } from "@/lib/instructions";
import { sendViaWallet } from "@/lib/tx";
import { spotPriceScaled } from "@/lib/ammMath";
import { loadSession } from "@/lib/session";
import { CLUSTER } from "@/lib/ammActions";
import { describeMarketPredicate } from "@/lib/statKeys";
import { getFixtureInfo } from "@/lib/fixtureMeta";
import { friendlyError } from "@/lib/errors";
import { Modal } from "./Modal";
import { FundingModal, useWalletFunds } from "./FundingModal";
import styles from "./FundingModal.module.css";

const fmt = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 2 });

interface Withdrawable {
  market: string;
  title: string;
  amount: bigint; // redeemable base units
  kind: "won" | "refund";
}

export function VaultPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { publicKey, signTransaction } = useWallet();
  const queryClient = useQueryClient();
  const { sol, usdc, refresh } = useWalletFunds(open);
  const [fundingOpen, setFundingOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const positions = useAmmPositionsForOwner(open ? publicKey : null);
  const marketPdas = useMemo(() => (positions.data ?? []).map((p) => p.market), [positions.data]);
  const pools = useAmmPoolMarkets(open && marketPdas.length > 0 ? marketPdas : undefined);

  // Market accounts for the positions (status decides what's withdrawable).
  const markets = useQuery<Map<string, OnChainMarket>>({
    queryKey: ["vaultMarkets", marketPdas.join(",")],
    queryFn: async () => {
      const out = new Map<string, OnChainMarket>();
      await Promise.all(
        marketPdas.map(async (pda) => {
          const m = await getMarket(pda);
          if (m) out.set(pda, m);
        }),
      );
      return out;
    },
    enabled: open && marketPdas.length > 0,
    staleTime: 15_000,
  });

  // Funds still at play: deposits + tokens valued at each pool's live price.
  const inMarkets = useMemo(() => {
    let total = 0n;
    for (const p of positions.data ?? []) {
      const m = markets.data?.get(p.market);
      const resolved = m && (m.status === STATUS_SETTLED || m.status === STATUS_CLAIMED);
      if (resolved) continue; // resolved markets count under "withdrawable" instead
      total += p.usdcAvailable;
      const pool = pools.data?.get(p.market);
      if (pool && pool.reserveA + pool.reserveB > 0n) {
        const priceA = spotPriceScaled(pool.reserveA, pool.reserveB);
        total += (p.tokensA * priceA + p.tokensB * (1_000_000n - priceA)) / 1_000_000n;
      }
    }
    return Number(total) / 1e6;
  }, [positions.data, pools.data, markets.data]);

  // Withdrawable: settled wins (deposits + winning tokens 1:1) and expired
  // refunds — the exact amounts redeem_amm pays, mirroring its program logic.
  const withdrawables = useMemo<Withdrawable[]>(() => {
    const now = Math.floor(Date.now() / 1000);
    const out: Withdrawable[] = [];
    for (const p of positions.data ?? []) {
      if (p.redeemed) continue;
      const m = markets.data?.get(p.market);
      if (!m) continue;
      const settled = m.status === STATUS_SETTLED || m.status === STATUS_CLAIMED;
      const expired = !settled && now > Number(m.deadline) + SETTLE_GRACE_SEC;
      if (!settled && !expired) continue;
      const winning = settled ? (m.outcome === OUTCOME_SIDE_A ? p.tokensA : p.tokensB) : 0n;
      const setTokens = p.tokensA < p.tokensB ? p.tokensA : p.tokensB;
      const amount = p.usdcAvailable + (settled ? winning : setTokens);
      if (amount === 0n) continue;
      out.push({
        market: p.market,
        title: describeMarketPredicate(m, getFixtureInfo(Number(m.fixtureId)) ?? undefined),
        amount,
        kind: settled ? "won" : "refund",
      });
    }
    return out;
  }, [positions.data, markets.data]);
  const withdrawableTotal = withdrawables.reduce((s, w) => s + Number(w.amount) / 1e6, 0);

  async function onWithdraw(w: Withdrawable) {
    if (!publicKey || !signTransaction) return;
    setError(null);
    setNote(null);
    setBusy(w.market);
    try {
      const usdcMint = await getConfigUsdcMint();
      if (!usdcMint) throw new Error("config not initialized");
      const ix = buildRedeemAmmIx({ owner: publicKey, market: new PublicKey(w.market), usdcMint });
      await sendViaWallet(getConnection(), new Transaction().add(ix), publicKey, signTransaction);
      setNote(`Withdrew ${fmt(Number(w.amount) / 1e6)} USDC to your wallet.`);
      await refresh();
      void queryClient.invalidateQueries();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(null);
    }
  }

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
                <span className={styles.balLabel}>in wallet (USDC)</span>
              </div>
              <div>
                <span className={styles.balValue}>{positions.isPending ? "…" : fmt(inMarkets)}</span>
                <span className={styles.balLabel}>working in markets</span>
              </div>
              <div>
                <span className={styles.balValue} style={withdrawableTotal > 0 ? { color: "var(--green)" } : undefined}>
                  {positions.isPending || markets.isPending ? "…" : fmt(withdrawableTotal)}
                </span>
                <span className={styles.balLabel}>ready to withdraw</span>
              </div>
              <div>
                <span className={styles.balValue}>{sol === null ? "…" : sol.toFixed(3)}</span>
                <span className={styles.balLabel}>SOL</span>
              </div>
            </div>

            {withdrawables.length > 0 && (
              <div className={styles.action}>
                <p className={styles.hint} style={{ margin: "0 0 6px", fontWeight: 600, color: "var(--text)" }}>
                  Ready to withdraw — one approval each, straight to your wallet:
                </p>
                {withdrawables.map((w) => (
                  <div key={w.market} className={styles.withdrawRow}>
                    <span className={styles.withdrawTitle}>
                      {w.kind === "won" ? "🏆 " : "↩ "}
                      {w.title}
                    </span>
                    <span className={styles.withdrawAmt}>{fmt(Number(w.amount) / 1e6)} USDC</span>
                    <button type="button" className="button" style={{ padding: "4px 12px", fontSize: "0.78rem" }} onClick={() => onWithdraw(w)} disabled={!!busy}>
                      {busy === w.market ? "Withdrawing…" : "Withdraw"}
                    </button>
                  </div>
                ))}
              </div>
            )}
            {note && <p className={styles.note}>{note}</p>}
            {error && <p className={styles.error}>{error}</p>}

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
              <button
                type="button"
                className="button"
                onClick={() => {
                  onClose(); // one modal at a time — vault hands off to funding
                  setFundingOpen(true);
                }}
              >
                Add funds
              </button>
              <Link href="/portfolio" className="button" data-variant="ghost" onClick={onClose}>
                All positions →
              </Link>
            </div>

            <p className={styles.explainer}>
              <strong>Non-custodial:</strong> money you add to a market sits in that market&apos;s on-chain
              escrow, owned by the program — never by ONYX. Winnings become &ldquo;ready to withdraw&rdquo; the
              moment a market settles, and Withdraw sends them straight from the escrow to your wallet (there is
              no platform account in between to trust). The trading key in your browser can only trade; it
              mathematically cannot withdraw.
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
