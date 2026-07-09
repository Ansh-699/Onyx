"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction } from "@solana/web3.js";
import { type OnChainMarket, STATUS_NAMES, getConfigUsdcMint, explorerTxUrl } from "@/lib/onchain";
import { buildSettleMarketIx, buildClaimIx, OP_NONE, type CapturedProofFixture } from "@/lib/instructions";
import capturedProof from "@/lib/fixtures/scores-validation.sample.json";

const DEMO_FIXTURE_ID = 18179550;
// The bundled proof only proves ONE stat (statsToProve[0]). settle_market's
// CPI args are built straight from that captured stat, NOT cross-checked
// against Market.statAKey/statBKey/op on-chain (see settle_market.rs) -- so
// this button must only ever appear for markets whose predicate is exactly
// "this one proven stat vs threshold" (statBKey=0, op=NONE, statAKey
// matching the capture). Any other shape (e.g. a combined ADD-of-two-stats
// market) would settle against the WRONG stat while looking legitimate --
// exactly the kind of silent misrepresentation this project argues against.
const PROVABLE_STAT_KEY = (capturedProof as unknown as CapturedProofFixture).payload.statsToProve[0]!.key;

export function SettleClaimPanel({ market }: { market: OnChainMarket }) {
  const router = useRouter();
  const { connection } = useConnection();
  const { publicKey, sendTransaction, connected } = useWallet();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastSig, setLastSig] = useState<string | null>(null);

  const provable =
    Number(market.fixtureId) === DEMO_FIXTURE_ID &&
    market.statBKey === 0 &&
    market.op === OP_NONE &&
    market.statAKey === PROVABLE_STAT_KEY;

  if (!provable) {
    const reason =
      Number(market.fixtureId) !== DEMO_FIXTURE_ID
        ? "this market's fixture doesn't have a captured oracle proof bundled in this build"
        : "this market's predicate combines stats the bundled proof doesn't cover (only a single stat[" +
          PROVABLE_STAT_KEY +
          "] proof is captured)";
    return (
      <p className="muted" style={{ fontSize: "0.85rem" }}>
        <code>settle_market</code> can&apos;t be triggered from the UI here —{" "}
        {reason}. It still works on-chain given the right proof payload from
        TxLINE&apos;s <code>/scores/stat-validation</code> endpoint. Create a
        market on the demo fixture with the default predicate from{" "}
        <code>/create</code> to see a live settlement.
      </p>
    );
  }

  const canSettle = market.status === 1 || market.status === 2; // Open or Live
  const canClaim = market.status === 4; // Settled

  async function onSettle() {
    if (!publicKey) return;
    setError(null);
    setBusy("Settling (real validate_stat CPI)…");
    try {
      const marketPk = new PublicKey(market.pda);
      const { ix, computeIx } = buildSettleMarketIx({
        submitter: publicKey,
        market: marketPk,
        fixture: capturedProof as unknown as CapturedProofFixture,
        threshold: market.threshold,
        predicate: market.predicate,
      });
      const tx = new Transaction().add(computeIx, ix);
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;
      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      setLastSig(sig);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card">
      <div style={{ fontWeight: 600 }}>Settlement</div>
      <p className="muted" style={{ fontSize: "0.85rem" }}>
        Status: {STATUS_NAMES[market.status] ?? market.status}. This CPIs into
        the sponsor's own <code>validate_stat</code> against the real captured
        proof — the outcome is decided by the oracle, not by ONYX.
      </p>
      <div style={{ display: "flex", gap: "0.75rem" }}>
        {canSettle && (
          <button className="button" type="button" onClick={onSettle} disabled={!connected || !!busy}>
            {busy ?? "Settle via validate_stat"}
          </button>
        )}
        {canClaim && (
          <button className="button" type="button" onClick={onClaim} disabled={!connected || !!busy}>
            {busy ?? "Claim payout"}
          </button>
        )}
      </div>
      {error && <p style={{ color: "var(--danger, #c33)", fontSize: "0.85rem" }}>{error}</p>}
      {lastSig && (
        <p className="muted" style={{ fontSize: "0.8rem" }}>
          <a href={explorerTxUrl(lastSig)} target="_blank" rel="noreferrer">
            last tx ↗
          </a>
        </p>
      )}
    </div>
  );
}
