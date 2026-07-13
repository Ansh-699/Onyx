"use client";

// Sealed-order trading panel — the commit / reveal / match lifecycle.
//
// Behaviors that must never regress:
// - The user's order secret (nonce/side/size/limitPrice) is persisted in
//   localStorage the moment the commit tx lands: it is UNRECOVERABLE from
//   chain (only a 32-byte hash lives there) until the user reveals it.
// - /api/faucet runs BEFORE every bet: a fresh wallet has no ATA and no
//   test-USDC, and submit_sealed_order does a raw SPL Transfer with no
//   ATA-creation fallback, so the first bet would otherwise fail with
//   "invalid account data for instruction" (real bug, really fixed).
// - /api/house-counter seeds an opposing house order right after the user's
//   bet, and asks the house to reveal once the reveal window opens — demo
//   liquidity so a solo bettor still gets matched.
// - Phase gating derives from market.phase + commitEndTs/revealEndTs.

import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  type OnChainMarket,
  PHASE_COMMIT,
  PHASE_MATCHED,
  PHASE_NAMES,
  ORDER_STATUS_NAMES,
  getConfigUsdcMint,
  explorerTxUrl,
  priceToPercent,
} from "@/lib/onchain";
import { useSealedOrders } from "@/lib/hooks";
import { friendlyError } from "@/lib/errors";
import { sendViaWallet } from "@/lib/tx";
import {
  buildSubmitSealedOrderIx,
  buildRevealOrderIx,
  buildRunBatchMatchIx,
  buildRefundUnrevealedIx,
  sealedCommitment,
  orderPda,
  SIDE_A,
  SIDE_B,
} from "@/lib/instructions";
import { WalletButton } from "@/components/WalletButton";
import { Countdown } from "@/components/market/Countdown";
import { fmtUsdc, poolShare, shortAddr } from "@/components/market/format";
import styles from "@/components/market/TradePanel.module.css";

interface SavedOrder {
  nonce: string;
  side: number;
  size: string; // base units (6dp) — same shape as before for back-compat
  limitPrice: string; // 0..1_000_000 scale
}

function storageKey(market: string, owner: string) {
  return `onyx:sealed:${market}:${owner}`;
}

const ORDER_TONES: Record<number, string> = {
  0: "amber", // Locked
  1: "accent", // Revealed
  2: "green", // Matched
  3: "red", // Refunded
};

export function SealedOrderPanel({ market }: { market: OnChainMarket }) {
  const queryClient = useQueryClient();
  const { connection } = useConnection();
  const { publicKey, signTransaction, connected } = useWallet();

  const ordersQuery = useSealedOrders(market.pda);
  const orders = useMemo(() => ordersQuery.data ?? [], [ordersQuery.data]);

  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastSig, setLastSig] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedOrder | null>(null);
  const [houseReady, setHouseReady] = useState(false);

  // Bet form state — human units (whole test-USDC, percent). Converted to
  // base units / the 0..1_000_000 price scale right below.
  const [side, setSide] = useState<number>(SIDE_A);
  const [sizeUsdc, setSizeUsdc] = useState<string>("1");
  const [limitPct, setLimitPct] = useState<string>("50");

  // Panel-local 1s tick for window gating only (the page above doesn't
  // re-render — countdown text ticks in the Countdown leaf).
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
    const mySize = saved?.size ?? sizeToBase(sizeUsdc)?.toString() ?? "1000000";
    fetch("/api/house-counter", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ market: market.pda, action: "reveal", userSide: mySide, userSize: mySize }),
    })
      .then(() => setHouseReady(true))
      .catch(() => {});
  }, [revealOpen, houseReady, market.pda, saved, side, sizeUsdc]);

  // ---- unit conversions (human → on-chain) ----
  const sizeBase = sizeToBase(sizeUsdc);
  const priceScaled = pctToScale(limitPct);
  const formValid = sizeBase !== null && priceScaled !== null;

  // ---- estimated parimutuel payout (before protocol fee) ----
  const totalPool = market.totalSideA + market.totalSideB;
  const winningPool = side === SIDE_A ? market.totalSideA : market.totalSideB;
  const losingPool = side === SIDE_A ? market.totalSideB : market.totalSideA;
  const estPayout =
    sizeBase !== null
      ? winningPool > 0n
        ? sizeBase + (sizeBase * losingPool) / winningPool
        : sizeBase + losingPool
      : null;

  const myOrder = useMemo(() => {
    if (!publicKey || !saved) return null;
    const me = publicKey.toBase58();
    return orders.find((o) => o.owner === me && o.nonce.toString() === saved.nonce) ?? null;
  }, [orders, publicKey, saved]);

  const revealedCount = useMemo(() => orders.filter((o) => o.revealed).length, [orders]);

  // Every one of THIS wallet's orders that is still Locked (never revealed),
  // read straight from chain — deliberately NOT gated on `saved`/localStorage.
  // A saved secret can go missing (different browser, cleared storage, or
  // exactly what happened on a real stuck order this session: committed from
  // one session, checked from another) — the reveal/reclaim alert below has
  // to work from on-chain truth alone, or a user in that situation gets no
  // signal at all that their collateral is sitting there reclaimable.
  const myUnrevealedOrders = useMemo(() => {
    const me2 = publicKey?.toBase58();
    if (!me2) return [];
    return orders.filter((o) => o.owner === me2 && !o.revealed && o.status === 0);
  }, [orders, publicKey]);
  const myUnrevealedWithSecret = useMemo(
    () => (saved ? myUnrevealedOrders.filter((o) => o.nonce.toString() === saved.nonce) : []),
    [myUnrevealedOrders, saved],
  );
  const myUnrevealedNoSecret = useMemo(
    () => myUnrevealedOrders.filter((o) => !saved || o.nonce.toString() !== saved.nonce),
    [myUnrevealedOrders, saved],
  );
  const canReclaim = nowSec >= revealEnd; // exact on-chain gate in refund_unrevealed.rs

  async function sendAndConfirm(tx: Transaction): Promise<string> {
    if (!publicKey || !signTransaction) throw new Error("wallet not connected");
    return sendViaWallet(connection, tx, publicKey, signTransaction);
  }

  async function placeBet(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!publicKey || sizeBase === null || priceScaled === null) return;
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
      const commitment = sealedCommitment(side, sizeBase, priceScaled, nonce, publicKey);
      const marketPk = new PublicKey(market.pda);
      const { ix } = buildSubmitSealedOrderIx({
        user: publicKey,
        market: marketPk,
        nonce,
        commitment,
        collateral: sizeBase,
        usdcMint,
      });
      const sig = await sendAndConfirm(new Transaction().add(ix));
      setLastSig(sig);

      // The secret order details only exist here until reveal — persist them.
      const record: SavedOrder = {
        nonce: nonce.toString(),
        side,
        size: sizeBase.toString(),
        limitPrice: priceScaled.toString(),
      };
      localStorage.setItem(storageKey(market.pda, publicKey.toBase58()), JSON.stringify(record));
      setSaved(record);

      // Seed the opposing house order so a solo bettor still gets matched.
      setBusy("Seeding counterparty liquidity…");
      await fetch("/api/house-counter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          market: market.pda,
          action: "submit",
          userSide: side,
          userSize: sizeBase.toString(),
        }),
      }).catch(() => {});

      await queryClient.invalidateQueries();
    } catch (err) {
      setError(friendlyError(err));
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
      const sig = await sendAndConfirm(new Transaction().add(ix));
      setLastSig(sig);
      await queryClient.invalidateQueries();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(null);
    }
  }

  async function reclaimOrder(orderPdaStr: string) {
    if (!publicKey) return;
    setError(null);
    setBusy("Reclaiming collateral…");
    try {
      const usdcMint = await getConfigUsdcMint();
      if (!usdcMint) throw new Error("config not initialized");
      const ownerAta = getAssociatedTokenAddressSync(usdcMint, publicKey);
      const ix = buildRefundUnrevealedIx({
        payer: publicKey,
        market: new PublicKey(market.pda),
        order: new PublicKey(orderPdaStr),
        ownerAta,
      });
      const sig = await sendAndConfirm(new Transaction().add(ix));
      setLastSig(sig);
      await queryClient.invalidateQueries();
    } catch (err) {
      setError(friendlyError(err));
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
      const sig = await sendAndConfirm(new Transaction().add(ix));
      setLastSig(sig);
      await queryClient.invalidateQueries();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(null);
    }
  }

  const me = publicKey?.toBase58();

  return (
    <div className={`card ${styles.wrap}`}>
      <div className={styles.head}>
        <span className={styles.title}>Trade — sealed batch order</span>
        <span className="pill" data-tone="accent">
          phase: {PHASE_NAMES[market.phase] ?? market.phase}
        </span>
      </div>

      <div className={styles.sealNote}>
        Your order is a 32-byte hash until the batch clears — nothing to front-run. Everyone
        reveals after the commit window, then one deterministic uniform-price match runs;
        submission order gives no edge.
      </div>

      {/* Un-missable, phase-independent: checks THIS wallet's on-chain orders
          directly (not gated on localStorage) so it still fires for a user
          whose saved secret is gone — the exact situation that stranded a
          real order. Reveal-urgency (amber) while the window is still open,
          reclaim (red, always actionable) once it's closed. */}
      {connected && myUnrevealedOrders.length > 0 && revealOpen && (
        <div className={styles.alert} data-tone="amber">
          <div className={styles.alertHead}>
            {myUnrevealedWithSecret.length > 0
              ? "Reveal now — window closes soon"
              : "Unrevealed order — can't be revealed from this browser"}
          </div>
          <p className={styles.alertBody}>
            {myUnrevealedWithSecret.length > 0 ? (
              <>
                Reveal window closes in <Countdown targetSec={revealEnd} />. Miss it and this
                order won&apos;t be matched — your collateral stays locked but reclaimable, it
                just won&apos;t win anything.
              </>
            ) : (
              <>
                This wallet has {myUnrevealedNoSecret.length} committed order
                {myUnrevealedNoSecret.length === 1 ? "" : "s"} on this market, but this browser
                doesn&apos;t hold the saved secret needed to reveal{" "}
                {myUnrevealedNoSecret.length === 1 ? "it" : "them"} — side, size, and price are
                only recoverable from the browser that committed the order, never from chain.{" "}
                {myUnrevealedNoSecret.length === 1 ? "It" : "They"} won&apos;t be matched. Once
                the reveal window closes in <Countdown targetSec={revealEnd} />, you can reclaim
                the collateral here.
              </>
            )}
          </p>
          {myUnrevealedWithSecret.length > 0 && (
            <button className="button" type="button" onClick={revealMine} disabled={!!busy}>
              {busy ? (
                <>
                  <span className={styles.spinner} aria-hidden /> {busy}
                </>
              ) : (
                "Reveal now"
              )}
            </button>
          )}
        </div>
      )}

      {connected && myUnrevealedOrders.length > 0 && canReclaim && (
        <div className={styles.alert} data-tone="red">
          <div className={styles.alertHead}>Collateral reclaimable</div>
          <p className={styles.alertBody}>
            The reveal window closed without {myUnrevealedOrders.length === 1 ? "this order" : "these orders"}{" "}
            being revealed, so {myUnrevealedOrders.length === 1 ? "it" : "they"} never entered
            matching. Nothing is lost — <code>refund_unrevealed</code> returns full collateral to
            your own wallet, on-chain-enforced (it can only ever land in the order&apos;s own
            owner ATA), any time.
          </p>
          <div className={styles.alertActions}>
            {myUnrevealedOrders.map((o) => (
              <button
                key={o.pda}
                className="button"
                type="button"
                onClick={() => reclaimOrder(o.pda)}
                disabled={!!busy}
              >
                {busy ? (
                  <>
                    <span className={styles.spinner} aria-hidden /> {busy}
                  </>
                ) : (
                  `Reclaim ${fmtUsdc(o.collateralLocked)} tUSDC`
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {!connected && <WalletButton />}

      {commitOpen && (
        <>
          <div className={styles.countRow}>
            <span>
              Commit window closes in <Countdown targetSec={commitEnd} />
            </span>
          </div>

          {saved ? (
            <SavedOrderCard
              saved={saved}
              note="Wait for the commit window to close, then reveal it below."
            />
          ) : (
            <form onSubmit={placeBet} className={styles.form}>
              <div className={styles.sides} role="group" aria-label="Pick a side">
                {(
                  [
                    { id: SIDE_A, name: "Side A", pool: market.totalSideA },
                    { id: SIDE_B, name: "Side B", pool: market.totalSideB },
                  ] as const
                ).map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className={styles.sideBtn}
                    data-active={side === s.id}
                    onClick={() => setSide(s.id)}
                    aria-pressed={side === s.id}
                  >
                    <span className={styles.sideName}>{s.name}</span>
                    <span className={styles.sideShare}>
                      pool {poolShare(s.pool, totalPool)} · {fmtUsdc(s.pool)} tUSDC
                    </span>
                  </button>
                ))}
              </div>

              <div className={styles.fields}>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Size (test-USDC)</span>
                  <input
                    value={sizeUsdc}
                    onChange={(e) => setSizeUsdc(e.target.value)}
                    inputMode="decimal"
                    placeholder="1"
                  />
                  <span className={styles.caption}>
                    {sizeBase !== null
                      ? `= ${sizeBase.toString()} base units (6dp)`
                      : "enter a positive amount"}
                  </span>
                </label>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Limit price (%)</span>
                  <input
                    value={limitPct}
                    onChange={(e) => setLimitPct(e.target.value)}
                    inputMode="decimal"
                    placeholder="50"
                  />
                  <span className={styles.caption}>
                    {priceScaled !== null
                      ? `= ${priceScaled.toString()} on the 0..1000000 scale`
                      : "must be between 0 and 100"}
                  </span>
                </label>
              </div>

              <div className={styles.payout}>
                <span className={styles.fieldLabel}>Estimated payout if you win</span>
                <span className={styles.payoutBig}>
                  {estPayout !== null ? `≈ ${fmtUsdc(estPayout)} tUSDC` : "—"}
                </span>
                <span className={styles.payoutNote}>
                  estimated, parimutuel, before the protocol fee — pools may shift until the
                  batch is matched
                </span>
              </div>

              <button className="button" type="submit" disabled={!connected || !!busy || !formValid}>
                {busy ? (
                  <>
                    <span className={styles.spinner} aria-hidden /> {busy}
                  </>
                ) : (
                  "Place sealed bet"
                )}
              </button>
            </form>
          )}
        </>
      )}

      {revealOpen && (
        <>
          <div className={styles.countRow}>
            <span>
              Reveal window closes in <Countdown targetSec={revealEnd} />
            </span>
            <span>
              {revealedCount}/{orders.length} orders revealed
            </span>
          </div>
          {saved ? (
            <button className="button" type="button" onClick={revealMine} disabled={!!busy}>
              {busy ? (
                <>
                  <span className={styles.spinner} aria-hidden /> {busy}
                </>
              ) : (
                "Reveal my bet"
              )}
            </button>
          ) : (
            <p className={styles.blurb}>
              The commit window has closed — orders committed earlier can now be revealed.
            </p>
          )}
        </>
      )}

      {matchReady && (
        <>
          <div className={styles.countRow}>
            <span>
              Reveal window closed · {revealedCount}/{orders.length} orders revealed
            </span>
          </div>
          {revealedCount > 0 ? (
            <button className="button" type="button" onClick={runMatch} disabled={!connected || !!busy}>
              {busy ? (
                <>
                  <span className={styles.spinner} aria-hidden /> {busy}
                </>
              ) : (
                "Run batch match"
              )}
            </button>
          ) : (
            <p className={styles.blurb}>
              No orders were revealed in this batch, so there is nothing to match.
            </p>
          )}
        </>
      )}

      {matched && (
        <div className={styles.payout}>
          <span className={styles.fieldLabel}>Batch cleared — real uniform clearing price</span>
          <span className={styles.payoutBig}>{priceToPercent(market.clearingPrice)}</span>
          {myOrder && myOrder.status === 2 && (
            <span className={styles.payoutNote}>
              your order matched {fmtUsdc(myOrder.matchedSize)} tUSDC at the clearing price
            </span>
          )}
        </div>
      )}

      {saved && !commitOpen && !matched && (
        <SavedOrderCard saved={saved} note="Reveal during the reveal window to make it count." />
      )}

      {saved && myOrder && (
        <div className={styles.saved}>
          <span className={styles.fieldLabel}>
            Your on-chain commitment (all anyone else can see)
          </span>
          <span className={styles.commitHex}>{myOrder.commitment}</span>
        </div>
      )}

      {orders.length > 0 && (
        <div className={styles.tableWrap}>
          <p className={styles.tableTitle}>Batch orders ({orders.length})</p>
          <table>
            <thead>
              <tr>
                <th>owner</th>
                <th>status</th>
                <th style={{ textAlign: "right" }}>matched</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.pda}>
                  <td className="mono">
                    {shortAddr(o.owner)}
                    {me === o.owner && (
                      <span className={`pill ${styles.youPill}`} data-tone="accent">
                        you
                      </span>
                    )}
                  </td>
                  <td>
                    <span className="pill" data-tone={ORDER_TONES[o.status]}>
                      {ORDER_STATUS_NAMES[o.status] ?? o.status}
                    </span>
                  </td>
                  <td style={{ textAlign: "right" }} className="mono">
                    {o.status === 2 ? `${fmtUsdc(o.matchedSize)} tUSDC` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {error && <p className={styles.error}>{error}</p>}
      {lastSig && (
        <p className={`muted ${styles.txRow}`}>
          <a href={explorerTxUrl(lastSig)} target="_blank" rel="noreferrer">
            last tx ↗
          </a>
        </p>
      )}
    </div>
  );
}

function SavedOrderCard({ saved, note }: { saved: SavedOrder; note: string }) {
  return (
    <div className={styles.saved}>
      <span className={styles.fieldLabel}>Your sealed order (stored in this browser)</span>
      <span>
        {saved.side === SIDE_A ? "Side A" : "Side B"} · {fmtUsdc(BigInt(saved.size))} tUSDC ·
        limit {priceToPercent(BigInt(saved.limitPrice))} · nonce{" "}
        <span className="mono">{saved.nonce}</span>
      </span>
      <span className={styles.payoutNote}>
        On-chain it&apos;s only a 32-byte hash — these details are unrecoverable from chain until
        you reveal. {note}
      </span>
    </div>
  );
}

/** Whole test-USDC string -> 6dp base units, or null if invalid. */
function sizeToBase(input: string): bigint | null {
  const n = Number(input);
  if (!Number.isFinite(n) || n <= 0) return null;
  const base = Math.round(n * 1_000_000);
  if (base <= 0 || base > Number.MAX_SAFE_INTEGER) return null;
  return BigInt(base);
}

/** Percent string (0..100 exclusive) -> 0..1_000_000 on-chain scale, or null. */
function pctToScale(input: string): bigint | null {
  const n = Number(input);
  if (!Number.isFinite(n) || n <= 0 || n >= 100) return null;
  return BigInt(Math.round(n * 10_000));
}
