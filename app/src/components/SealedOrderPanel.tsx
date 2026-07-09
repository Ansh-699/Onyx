"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  type OnChainMarket,
  type OnChainSealedOrder,
  PHASE_COMMIT,
  PHASE_REVEAL,
  PHASE_MATCHED,
  PHASE_NAMES,
  ORDER_STATUS_NAMES,
  listSealedOrders,
  getConfigUsdcMint,
  explorerTxUrl,
  priceToPercent,
} from "@/lib/onchain";
import {
  buildSubmitSealedOrderIx,
  buildRevealOrderIx,
  buildRunBatchMatchIx,
  sealedCommitment,
  orderPda,
  SIDE_A,
  SIDE_B,
} from "@/lib/instructions";
import { WalletButton } from "@/components/WalletButton";

interface SavedOrder {
  nonce: string;
  side: number;
  size: string;
  limitPrice: string;
}

function storageKey(market: string, owner: string) {
  return `onyx:sealed:${market}:${owner}`;
}

function fmtCountdown(seconds: number): string {
  if (seconds <= 0) return "now";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

export function SealedOrderPanel({ market }: { market: OnChainMarket }) {
  const router = useRouter();
  const { connection } = useConnection();
  const { publicKey, sendTransaction, connected } = useWallet();

  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastSig, setLastSig] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedOrder | null>(null);
  const [orders, setOrders] = useState<OnChainSealedOrder[]>([]);
  const [houseReady, setHouseReady] = useState(false);

  // Bet form state.
  const [side, setSide] = useState<number>(SIDE_A);
  const [size, setSize] = useState<string>("1000000"); // 1.000000 (6dp test USDC)
  const [limitPrice, setLimitPrice] = useState<string>("500000"); // 50%

  useEffect(() => {
    const t = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!publicKey) {
      setSaved(null);
      return;
    }
    const raw = localStorage.getItem(storageKey(market.pda, publicKey.toBase58()));
    setSaved(raw ? (JSON.parse(raw) as SavedOrder) : null);
  }, [market.pda, publicKey]);

  const refreshOrders = useCallback(async () => {
    const list = await listSealedOrders(market.pda);
    setOrders(list);
  }, [market.pda]);

  useEffect(() => {
    refreshOrders();
  }, [refreshOrders]);

  const commitEnd = Number(market.commitEndTs);
  const revealEnd = Number(market.revealEndTs);
  const commitOpen = market.phase === PHASE_COMMIT && nowSec < commitEnd;
  const revealOpen = nowSec >= commitEnd && nowSec < revealEnd && market.phase !== PHASE_MATCHED;
  const matchReady = nowSec >= revealEnd && market.phase !== PHASE_MATCHED;
  const matched = market.phase === PHASE_MATCHED;

  // Best-effort: once the reveal window opens, ask the house counterparty to
  // reveal its side too (idempotent; safe to call repeatedly).
  useEffect(() => {
    if (!revealOpen || houseReady) return;
    const mySide = saved?.side ?? side;
    const mySize = saved?.size ?? size;
    fetch("/api/house-counter", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ market: market.pda, action: "reveal", userSide: mySide, userSize: mySize }),
    })
      .then(() => setHouseReady(true))
      .catch(() => {});
  }, [revealOpen, houseReady, market.pda, saved, side, size]);

  async function placeBet(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!publicKey) return;
    setBusy("Getting devnet test-USDC…");
    try {
      const usdcMint = await getConfigUsdcMint();
      if (!usdcMint) throw new Error("config not initialized on devnet yet");

      // A fresh wallet has no ATA and no balance for the test-USDC mint;
      // submit_sealed_order does a raw SPL Transfer with no ATA-creation
      // fallback, so the very first bet from any new wallet would otherwise
      // fail with "invalid account data for instruction". Ensure both exist
      // before building the order (server-side devnet faucet, same
      // create-ATA-if-missing + mint-if-low pattern already used for the
      // house counterparty in api/house-counter).
      const faucetRes = await fetch("/api/faucet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user: publicKey.toBase58() }),
      });
      const faucetBody = await faucetRes.json();
      if (!faucetRes.ok || !faucetBody.ok) {
        throw new Error(`devnet faucet failed: ${faucetBody.error ?? faucetRes.status}`);
      }

      setBusy("Placing sealed bet…");
      const nonce = BigInt(Math.floor(Math.random() * 1_000_000_000));
      const sizeB = BigInt(size);
      const priceB = BigInt(limitPrice);
      const commitment = sealedCommitment(side, sizeB, priceB, nonce, publicKey);
      const marketPk = new PublicKey(market.pda);
      const { ix } = buildSubmitSealedOrderIx({
        user: publicKey,
        market: marketPk,
        nonce,
        commitment,
        collateral: sizeB,
        usdcMint,
      });
      const tx = new Transaction().add(ix);
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;
      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      setLastSig(sig);

      const record: SavedOrder = { nonce: nonce.toString(), side, size, limitPrice };
      localStorage.setItem(storageKey(market.pda, publicKey.toBase58()), JSON.stringify(record));
      setSaved(record);

      // Seed the opposing house order so a solo bettor still gets matched.
      setBusy("Seeding counterparty liquidity…");
      await fetch("/api/house-counter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ market: market.pda, action: "submit", userSide: side, userSize: size }),
      }).catch(() => {});

      await refreshOrders();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function revealMine() {
    if (!publicKey || !saved) return;
    setError(null);
    setBusy("Revealing…");
    try {
      const marketPk = new PublicKey(market.pda);
      const order = orderPda(marketPk, publicKey, BigInt(saved.nonce));
      const ix = buildRevealOrderIx({
        user: publicKey,
        market: marketPk,
        order,
        side: saved.side,
        size: BigInt(saved.size),
        limitPrice: BigInt(saved.limitPrice),
        nonce: BigInt(saved.nonce),
      });
      const tx = new Transaction().add(ix);
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;
      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      setLastSig(sig);
      await refreshOrders();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function runMatch() {
    if (!publicKey) return;
    setError(null);
    setBusy("Running batch match…");
    try {
      const usdcMint = await getConfigUsdcMint();
      if (!usdcMint) throw new Error("config not initialized");
      const marketPk = new PublicKey(market.pda);
      const revealed = orders.filter((o) => o.revealed && o.status === 1);
      if (revealed.length === 0) throw new Error("no revealed orders to match");
      const ix = buildRunBatchMatchIx({
        payer: publicKey,
        market: marketPk,
        orders: revealed.map((o) => ({
          order: new PublicKey(o.pda),
          owner: new PublicKey(o.owner),
          usdcAta: getAssociatedTokenAddressSync(usdcMint, new PublicKey(o.owner)),
        })),
      });
      const tx = new Transaction().add(ix);
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;
      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      setLastSig(sig);
      await refreshOrders();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const revealedCount = useMemo(() => orders.filter((o) => o.revealed).length, [orders]);

  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div style={{ fontWeight: 600 }}>Sealed order intent (Level 1, O7)</div>
        <span className="pill">phase: {PHASE_NAMES[market.phase] ?? market.phase}</span>
      </div>
      <p className="muted" style={{ fontSize: "0.85rem" }}>
        Orders are hidden (a 32-byte commitment hash + locked collateral only)
        until the commit window closes. Then everyone reveals, and a single
        deterministic uniform-price batch match runs — no order benefits from
        submission order.
      </p>

      {!connected && (
        <div style={{ marginTop: "0.75rem" }}>
          <WalletButton />
        </div>
      )}

      {commitOpen && (
        <>
          <div className="muted" style={{ fontSize: "0.8rem", marginBottom: "0.5rem" }}>
            Commit window closes in {fmtCountdown(commitEnd - nowSec)}
          </div>
          {saved ? (
            <p className="muted">
              You already have a sealed order in this market (nonce {saved.nonce}). Wait
              for the commit window to close, then reveal it below.
            </p>
          ) : (
            <form onSubmit={placeBet} style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", alignItems: "flex-end" }}>
              <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
                <span className="muted" style={{ fontSize: "0.75rem" }}>Side</span>
                <select value={side} onChange={(e) => setSide(Number(e.target.value))}>
                  <option value={SIDE_A}>Side A</option>
                  <option value={SIDE_B}>Side B</option>
                </select>
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
                <span className="muted" style={{ fontSize: "0.75rem" }}>Size (base units)</span>
                <input value={size} onChange={(e) => setSize(e.target.value)} style={{ width: 120 }} />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
                <span className="muted" style={{ fontSize: "0.75rem" }}>Limit price (0..1000000)</span>
                <input value={limitPrice} onChange={(e) => setLimitPrice(e.target.value)} style={{ width: 120 }} />
              </label>
              <button className="button" type="submit" disabled={!connected || !!busy}>
                {busy ?? "Place sealed bet"}
              </button>
            </form>
          )}
        </>
      )}

      {revealOpen && (
        <>
          <div className="muted" style={{ fontSize: "0.8rem", marginBottom: "0.5rem" }}>
            Reveal window closes in {fmtCountdown(revealEnd - nowSec)} · {revealedCount}/{orders.length} orders revealed
          </div>
          {saved && (
            <button className="button" type="button" onClick={revealMine} disabled={!!busy}>
              {busy ?? "Reveal my bet"}
            </button>
          )}
        </>
      )}

      {matchReady && (
        <button className="button" type="button" onClick={runMatch} disabled={!connected || !!busy}>
          {busy ?? "Run batch match"}
        </button>
      )}

      {matched && (
        <div>
          <div className="muted" style={{ fontSize: "0.8rem" }}>Clearing price</div>
          <div style={{ fontWeight: 600 }}>{priceToPercent(market.clearingPrice)}</div>
        </div>
      )}

      {orders.length > 0 && (
        <table className="mono" style={{ width: "100%", marginTop: "1rem", fontSize: "0.8rem" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>order</th>
              <th style={{ textAlign: "left" }}>status</th>
              <th style={{ textAlign: "right" }}>matched</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.pda}>
                <td>{o.pda.slice(0, 8)}…</td>
                <td>{ORDER_STATUS_NAMES[o.status] ?? o.status}</td>
                <td style={{ textAlign: "right" }}>{o.matchedSize.toString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {error && (
        <p style={{ color: "var(--danger, #c33)", fontSize: "0.85rem" }}>{error}</p>
      )}
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
