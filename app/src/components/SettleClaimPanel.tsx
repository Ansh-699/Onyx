"use client";

import { useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction } from "@solana/web3.js";
import {
  type OnChainMarket,
  STATUS_NAMES,
  STATUS_OPEN,
  STATUS_LIVE,
  STATUS_SETTLED,
  STATUS_CLAIMED,
  getConfigUsdcMint,
  explorerTxUrl,
} from "@/lib/onchain";
import { buildSettleMarketIx, buildClaimIx, OP_NONE, type CapturedProofFixture } from "@/lib/instructions";
import capturedProof from "@/lib/fixtures/scores-validation.sample.json";
import { friendlyError } from "@/lib/errors";
import { WalletButton } from "@/components/WalletButton";
import styles from "@/components/market/TradePanel.module.css";

const DEMO_FIXTURE_ID = 18179550;
// The bundled proof only proves ONE stat (statsToProve[0]). It's only a
// faithful proof for a market whose predicate is EXACTLY "this one proven
// stat vs threshold" (statBKey=0, op=NONE, statAKey matching the capture) --
// settle_market's CPI args aren't cross-checked against Market.statAKey/
// statBKey/op on-chain (see settle_market.rs), so using the wrong proof for
// a market's real predicate would settle against the WRONG stat while
// looking legitimate. Any OTHER market (different fixture, or a combined
// two-stat predicate) now goes through /api/settlement-proof instead, which
// fetches a live proof for that market's own on-chain terms specifically --
// see txlineSettlementProof.ts.
const PROVABLE_STAT_KEY = (capturedProof as unknown as CapturedProofFixture).payload.statsToProve[0]!.key;

interface LiveProofResult {
  ok: boolean;
  fixture?: CapturedProofFixture;
  reason?: string;
}

export function SettleClaimPanel({ market, isAmm = false }: { market: OnChainMarket; isAmm?: boolean }) {
  const queryClient = useQueryClient();
  const { connection } = useConnection();
  const { publicKey, sendTransaction, connected } = useWallet();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastSig, setLastSig] = useState<string | null>(null);

  const usesBundledProof =
    Number(market.fixtureId) === DEMO_FIXTURE_ID &&
    market.statBKey === 0 &&
    market.op === OP_NONE &&
    market.statAKey === PROVABLE_STAT_KEY;

  const settled = market.status === STATUS_SETTLED || market.status === STATUS_CLAIMED;
  // Settlement needs FINAL match stats — before the deadline (kickoff) the
  // oracle proof either doesn't exist or reflects a match still in play, so
  // offering the button pre-deadline guarantees a reverted transaction (seen
  // live: Phantom "reverted during simulation" on an upcoming fixture).
  // Exception: the bundled demo fixture's match is already finished (its
  // proof ships with the build), so pre-deadline settlement there succeeds —
  // and the reproducible browser proof depends on it. The program itself
  // stays permissionless; this is a UI gate only.
  const deadlinePassed = Math.floor(Date.now() / 1000) >= Number(market.deadline);
  const settleReady = deadlinePassed || usesBundledProof;
  const canSettle = (market.status === STATUS_OPEN || market.status === STATUS_LIVE) && settleReady;
  const settleLocked = (market.status === STATUS_OPEN || market.status === STATUS_LIVE) && !settleReady;
  // claim is the sealed/parimutuel Position path — an AMM market has no
  // Position accounts (payouts go through redeem_amm in the trade panel),
  // so offering Claim there guarantees a failed transaction.
  const canClaim = market.status === STATUS_SETTLED && !isAmm;

  async function onSettle() {
    if (!publicKey) return;
    setError(null);
    try {
      let fixture: CapturedProofFixture;
      let op: number | undefined;

      if (usesBundledProof) {
        setBusy("Settling (real validate_stat CPI)…");
        fixture = capturedProof as unknown as CapturedProofFixture;
        op = undefined;
      } else {
        setBusy("Fetching live settlement proof from TxLINE…");
        const res = await fetch(`/api/settlement-proof/${market.pda}`);
        const body = (await res.json()) as LiveProofResult;
        if (!body.ok || !body.fixture) {
          throw new Error(
            body.reason ??
              "TxLINE has no settlement proof available for this market yet — retry once the fixture has real recorded data.",
          );
        }
        fixture = body.fixture;
        op = market.op !== OP_NONE ? market.op : undefined;
        setBusy("Settling (real validate_stat CPI, live-fetched proof)…");
      }

      const marketPk = new PublicKey(market.pda);
      const { ix, computeIx } = buildSettleMarketIx({
        submitter: publicKey,
        market: marketPk,
        fixture,
        threshold: market.threshold,
        predicate: market.predicate,
        op,
      });
      const tx = new Transaction().add(computeIx, ix);
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;
      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      setLastSig(sig);
      await queryClient.invalidateQueries({ queryKey: ["market", market.pda] });
      await queryClient.invalidateQueries({ queryKey: ["markets"] });
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(null);
    }
  }

  async function onClaim() {
    if (!publicKey) return;
    setError(null);
    setBusy("Claiming payout…");
    try {
      const usdcMint = await getConfigUsdcMint();
      if (!usdcMint) throw new Error("config not initialized");
      const marketPk = new PublicKey(market.pda);
      const ix = buildClaimIx({ winner: publicKey, market: marketPk, usdcMint });
      const tx = new Transaction().add(ix);
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;
      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      setLastSig(sig);
      await queryClient.invalidateQueries({ queryKey: ["market", market.pda] });
      await queryClient.invalidateQueries({ queryKey: ["markets"] });
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className={`card ${styles.wrap}`}>
      <div className={styles.head}>
        <span className={styles.title}>Settlement</span>
        <span className="pill">{STATUS_NAMES[market.status] ?? market.status}</span>
      </div>
      <p className={styles.blurb}>
        This CPIs into the sponsor&apos;s own <code>validate_stat</code> against a real proof — the outcome
        is decided by the oracle, not by ONYX.{" "}
        {usesBundledProof
          ? "Uses this build's bundled captured proof."
          : "Fetches a live proof from TxLINE's /scores/stat-validation for this exact market's fixture and stat at settlement time."}
      </p>
      {!connected && <WalletButton />}
      {settleLocked && (
        <p className={styles.blurb}>
          Settlement opens after the deadline ({new Date(Number(market.deadline) * 1000).toLocaleString()}),
          once TxLINE has the final match stats. Anyone can trigger it then — it&apos;s permissionless.
        </p>
      )}
      {connected && (canSettle || canClaim) && (
        <div style={{ display: "flex", gap: "0.75rem" }}>
          {canSettle && (
            <button className="button" type="button" onClick={onSettle} disabled={!!busy}>
              {busy ? (
                <>
                  <span className={styles.spinner} /> {busy}
                </>
              ) : (
                "Settle via validate_stat"
              )}
            </button>
          )}
          {canClaim && (
            <button className="button" type="button" onClick={onClaim} disabled={!!busy}>
              {busy ? (
                <>
                  <span className={styles.spinner} /> {busy}
                </>
              ) : (
                "Claim payout"
              )}
            </button>
          )}
        </div>
      )}
      {error && <p className={styles.error}>{error}</p>}
      {lastSig && (
        <p className={styles.txRow}>
          <a href={explorerTxUrl(lastSig)} target="_blank" rel="noreferrer">
            last tx ↗
          </a>
        </p>
      )}
      {settled && isAmm && (
        <p className={styles.blurb} style={{ marginTop: 4 }}>
          AMM market — redeem your position in the trade panel (deposits + winning tokens), not here.
        </p>
      )}
      {settled && (
        <p className={styles.txRow}>
          <Link href={`/receipt/${market.pda}`}>View verifiable receipt →</Link>
        </p>
      )}
    </div>
  );
}
