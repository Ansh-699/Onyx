"use client";

// Funding modal — the ONE place money enters a wallet on this devnet build:
//   1. "Get free devnet USDC": /api/faucet mints test-USDC (we hold the
//      mint authority of a toy token; throttled server-side).
//   2. "Buy with SOL": /api/buy-usdc returns ONE atomic transaction — your
//      SOL transfer to the treasury + the treasury's tUSDC mint to you —
//      partial-signed by the treasury; your wallet adds the second
//      signature here and broadcasts. Fixed toy rate 1 SOL = 200 tUSDC,
//      devnet only, disclosed below.
// Trading flows no longer auto-mint behind your back — if you're short,
// they point you here instead.

import { useCallback, useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { getConnection, getConfigUsdcMint, explorerTxUrl } from "@/lib/onchain";
import { broadcastAndConfirm } from "@/lib/tx";
import { friendlyError } from "@/lib/errors";
import { Modal } from "./Modal";
import styles from "./FundingModal.module.css";

const RATE = 200; // tUSDC per SOL — mirrors /api/buy-usdc

export function useWalletFunds(open: boolean) {
  const { publicKey } = useWallet();
  const [sol, setSol] = useState<number | null>(null);
  const [usdc, setUsdc] = useState<number | null>(null);
  const refresh = useCallback(async () => {
    if (!publicKey) return;
    const conn = getConnection();
    const [lamports, mint] = await Promise.all([conn.getBalance(publicKey), getConfigUsdcMint()]);
    setSol(lamports / 1e9);
    if (mint) {
      const ata = getAssociatedTokenAddressSync(mint, publicKey);
      const bal = await conn
        .getTokenAccountBalance(ata)
        .then((r) => Number(r.value.amount) / 1e6)
        .catch(() => 0);
      setUsdc(bal);
    }
  }, [publicKey]);
  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);
  return { sol, usdc, refresh };
}

export function FundingModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { publicKey, signTransaction } = useWallet();
  const { sol, usdc, refresh } = useWalletFunds(open);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [solAmount, setSolAmount] = useState("0.1");
  const [lastSig, setLastSig] = useState<string | null>(null);

  async function onFaucet() {
    if (!publicKey) return;
    setError(null);
    setNote(null);
    setBusy("Minting devnet USDC…");
    try {
      const res = await fetch("/api/faucet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user: publicKey.toBase58() }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) throw new Error(body.error ?? `faucet ${res.status}`);
      const minted = Number(BigInt(body.minted ?? "0")) / 1e6;
      setNote(
        minted > 0
          ? `Minted ${minted.toFixed(2)} devnet USDC to your wallet.`
          : "You're above the faucet threshold (50 USDC) or on cooldown — balance unchanged.",
      );
      await refresh();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(null);
    }
  }

  async function onBuyWithSol() {
    if (!publicKey || !signTransaction) return;
    const solNum = Number(solAmount);
    if (!Number.isFinite(solNum) || solNum <= 0) return;
    setError(null);
    setNote(null);
    setBusy("Preparing exchange…");
    try {
      const lamports = Math.round(solNum * 1e9);
      const res = await fetch("/api/buy-usdc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user: publicKey.toBase58(), lamports: String(lamports) }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) throw new Error(body.error ?? `buy-usdc ${res.status}`);
      setBusy("Waiting for your wallet…");
      // The server fixed the blockhash when it partial-signed — sign as-is.
      const tx = Transaction.from(Buffer.from(body.tx, "base64"));
      const signed = await signTransaction(tx);
      setBusy("Confirming on devnet…");
      const sig = await broadcastAndConfirm(getConnection(), signed.serialize(), body.blockhash, body.lastValidBlockHeight);
      const bought = Number(BigInt(body.usdcOut)) / 1e6;
      setNote(`Bought ${bought.toFixed(2)} devnet USDC for ${solNum} SOL — `);
      setLastSig(sig);
      await refresh();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add funds">
      {publicKey ? (
        <>
          <div className={styles.balances}>
            <div>
              <span className={styles.balValue}>{usdc === null ? "…" : usdc.toFixed(2)}</span>
              <span className={styles.balLabel}>devnet USDC</span>
            </div>
            <div>
              <span className={styles.balValue}>{sol === null ? "…" : sol.toFixed(3)}</span>
              <span className={styles.balLabel}>SOL</span>
            </div>
          </div>

          <div className={styles.action}>
            <button type="button" className="button" onClick={onFaucet} disabled={!!busy} data-testid="funding-faucet">
              {busy === "Minting devnet USDC…" ? busy : "Get free devnet USDC"}
            </button>
            <p className={styles.hint}>Tops you up to ~100 if you&apos;re below 50 (10-min cooldown). Free — it&apos;s a test token.</p>
          </div>

          <div className={styles.action}>
            <div className={styles.buyRow}>
              <input
                value={solAmount}
                onChange={(e) => setSolAmount(e.target.value)}
                inputMode="decimal"
                aria-label="SOL to spend"
                data-testid="funding-sol-amount"
              />
              <span className={styles.buyEq}>SOL ≈ {(Number(solAmount) * RATE || 0).toFixed(0)} USDC</span>
              <button type="button" className="button" onClick={onBuyWithSol} disabled={!!busy || !(Number(solAmount) > 0)} data-testid="funding-buy-sol">
                {busy && busy !== "Minting devnet USDC…" ? busy : "Buy with SOL"}
              </button>
            </div>
            <p className={styles.hint}>
              One transaction: your SOL goes to the treasury, USDC is minted to you atomically. Fixed devnet rate
              1 SOL = {RATE} USDC (toy pricing — on mainnet you&apos;d bring real USDC instead).
            </p>
          </div>

          {note && (
            <p className={styles.note}>
              {note}
              {lastSig && note.endsWith("— ") && (
                <a href={explorerTxUrl(lastSig)} target="_blank" rel="noreferrer">
                  view transaction ↗
                </a>
              )}
            </p>
          )}
          {error && <p className={styles.error}>{error}</p>}

          <p className={styles.explainer}>
            <strong>Where your money lives:</strong> funds stay in your wallet until you add them to a market;
            they then sit in that market&apos;s on-chain escrow (owned by the program — never by ONYX) and come
            back to your wallet when you sell, win, or withdraw.
          </p>
        </>
      ) : (
        <p className="muted">Connect a wallet first.</p>
      )}
    </Modal>
  );
}
