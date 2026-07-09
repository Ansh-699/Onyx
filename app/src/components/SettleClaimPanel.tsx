"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction } from "@solana/web3.js";
import { type OnChainMarket, STATUS_NAMES, getConfigUsdcMint, explorerTxUrl } from "@/lib/onchain";
import { buildSettleMarketIx, buildClaimIx, type CapturedProofFixture } from "@/lib/instructions";
import capturedProof from "@/lib/fixtures/scores-validation.sample.json";

const DEMO_FIXTURE_ID = 18179550;

export function SettleClaimPanel({ market }: { market: OnChainMarket }) {
  const router = useRouter();
  const { connection } = useConnection();
  const { publicKey, sendTransaction, connected } = useWallet();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastSig, setLastSig] = useState<string | null>(null);

  if (Number(market.fixtureId) !== DEMO_FIXTURE_ID) {
    return (
      <p className="muted" style={{ fontSize: "0.85rem" }}>
        This market's fixture doesn't have a captured oracle proof bundled in
        this build, so <code>settle_market</code> can't be triggered from the
        UI here (it still works — it just needs a real proof payload from
        TxLINE's <code>/scores/stat-validation</code> endpoint for this
        fixture). Create a market on the demo fixture from <code>/create</code>{" "}
        to see a live settlement.
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
