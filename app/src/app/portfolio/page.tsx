"use client";

// Portfolio — every row on this page is a live devnet read (getProgramAccounts
// on the ONYX program filtered by this wallet), never mock data. Wallet-gated:
// a stable placeholder renders until the client has mounted so the server and
// first client paint always agree (no hydration mismatch, no flash).

import { useEffect, useState } from "react";
import Link from "next/link";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction } from "@solana/web3.js";
import { useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import {
  type OnChainMarket,
  getMarket,
  getConfigUsdcMint,
  STATUS_NAMES,
  STATUS_SETTLED,
  STATUS_CLAIMED,
  ORDER_STATUS_NAMES,
  explorerTxUrl,
} from "@/lib/onchain";
import {
  type OnChainPosition,
  listPositionsByOwner,
  listSealedOrdersByOwner,
} from "@/lib/positions";
import { buildClaimIx } from "@/lib/instructions";
import { friendlyError } from "@/lib/errors";
import { describeMarketPredicate } from "@/lib/statKeys";
import { getFixtureInfo, fixtureDisplayName } from "@/lib/fixtureMeta";
import { WalletButton } from "@/components/WalletButton";
import styles from "./portfolio.module.css";

// ---- helpers ----

interface PositionRow {
  position: OnChainPosition;
  market: OnChainMarket | null; // null if the market account couldn't be read
}

function fmtUsdc(v: bigint): string {
  return (Number(v) / 1e6).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function shortPda(pda: string): string {
  return `${pda.slice(0, 4)}…${pda.slice(-4)}`;
}

type PosState = "claimable" | "claimed" | "lost" | "open" | "unknown";

function positionState(p: OnChainPosition, m: OnChainMarket | null): PosState {
  if (p.claimed) return "claimed";
  if (!m) return "unknown";
  const resolved = m.status === STATUS_SETTLED || m.status === STATUS_CLAIMED;
  if (!resolved) return "open";
  return m.outcome === p.side ? "claimable" : "lost";
}

const STATE_ORDER: Record<PosState, number> = {
  claimable: 0,
  open: 1,
  claimed: 2,
  lost: 3,
  unknown: 4,
};

const STATE_CHIP: Record<PosState, { label: string; tone?: string }> = {
  claimable: { label: "Claimable", tone: "green" },
  claimed: { label: "Claimed ✓", tone: "accent" },
  lost: { label: "Lost", tone: "red" },
  open: { label: "Open", tone: "amber" },
  unknown: { label: "—" },
};

function statusTone(status: number): string | undefined {
  if (status === STATUS_SETTLED || status === STATUS_CLAIMED) return "accent";
  return undefined;
}

function orderStatusTone(status: number): string | undefined {
  if (status === 0) return "amber"; // Locked
  if (status === 1) return "accent"; // Revealed
  return undefined;
}

// ---- page ----

export default function PortfolioPage() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const { connection } = useConnection();
  const { publicKey, connected, sendTransaction } = useWallet();
  const queryClient = useQueryClient();

  const owner = publicKey?.toBase58() ?? null;
  const ready = mounted && connected && !!publicKey;

  const positionsQuery = useQuery<PositionRow[]>({
    queryKey: ["positions", owner],
    queryFn: async () => {
      const positions = await listPositionsByOwner(publicKey!);
      // One market fetch per unique market, batched — this stays one query.
      const marketPdas = [...new Set(positions.map((p) => p.market))];
      const fetched = await Promise.all(marketPdas.map((pda) => getMarket(pda)));
      const byPda = new Map(marketPdas.map((pda, i) => [pda, fetched[i] ?? null]));
      return positions
        .map((position) => ({ position, market: byPda.get(position.market) ?? null }))
        .sort(
          (a, b) =>
            STATE_ORDER[positionState(a.position, a.market)] -
            STATE_ORDER[positionState(b.position, b.market)],
        );
    },
    refetchInterval: 15_000,
    placeholderData: keepPreviousData,
    enabled: ready,
  });

  const ordersQuery = useQuery({
    queryKey: ["myOrders", owner],
    queryFn: () => listSealedOrdersByOwner(publicKey!),
    refetchInterval: 15_000,
    placeholderData: keepPreviousData,
    enabled: ready,
  });

  // ---- claim flow ----
  const [claiming, setClaiming] = useState<string | null>(null); // position pda in flight
  const [claimError, setClaimError] = useState<string | null>(null);
  const [claimSig, setClaimSig] = useState<string | null>(null);

  async function onClaim(row: PositionRow) {
    if (!publicKey) return;
    setClaimError(null);
    setClaiming(row.position.pda);
    try {
      const usdcMint = await getConfigUsdcMint();
      if (!usdcMint) throw new Error("config not initialized on devnet");
      const ix = buildClaimIx({
        winner: publicKey,
        market: new PublicKey(row.position.market),
        usdcMint,
      });
      const tx = new Transaction().add(ix);
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;
      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      setClaimSig(sig);
      await queryClient.invalidateQueries({ queryKey: ["positions", owner] });
      await queryClient.invalidateQueries({ queryKey: ["myOrders", owner] });
    } catch (err) {
      setClaimError(friendlyError(err));
    } finally {
      setClaiming(null);
    }
  }

  // ---- render ----

  const header = (
    <>
      <h1>Portfolio</h1>
      <p className={`muted ${styles.intro}`}>
        Your positions and sealed orders, read live from the ONYX program on
        devnet — every row is a real{" "}
        <span className="mono">getProgramAccounts</span> result for your
        wallet, refreshed every ~15s.
      </p>
    </>
  );

  // Stable placeholder until mounted: identical on server and first client paint.
  if (!mounted) {
    return (
      <>
        {header}
        <div className={styles.rows} aria-hidden>
          <div className={`skeleton ${styles.skelRow}`} />
          <div className={`skeleton ${styles.skelRow}`} />
          <div className={`skeleton ${styles.skelRow}`} />
        </div>
      </>
    );
  }

  if (!connected || !publicKey) {
    return (
      <>
        {header}
        <div className={`card ${styles.gate}`}>
          <div className={styles.gateTitle}>Connect a wallet to see your positions</div>
          <p className="muted" style={{ margin: 0, fontSize: "0.88rem" }}>
            Positions, pending sealed orders, and claimable payouts are all
            derived from on-chain accounts owned by your wallet.
          </p>
          <WalletButton />
        </div>
      </>
    );
  }

  const rows = positionsQuery.data;
  const orders = ordersQuery.data;
  const pendingOrders = orders?.filter((o) => o.status === 0 || o.status === 1);
  const receiptMarkets = rows
    ? [
        ...new Map(
          rows
            .filter(
              (r) =>
                r.market &&
                (r.market.status === STATUS_SETTLED || r.market.status === STATUS_CLAIMED),
            )
            .map((r) => [r.position.market, r] as const),
        ).values(),
      ]
    : [];

  return (
    <>
      {header}

      {/* ---- Positions ---- */}
      <section className={styles.section}>
        <h2>Positions</h2>
        {positionsQuery.isPending ? (
          <div className={styles.rows} aria-hidden>
            <div className={`skeleton ${styles.skelRow}`} />
            <div className={`skeleton ${styles.skelRow}`} />
          </div>
        ) : positionsQuery.isError ? (
          <p className={styles.error}>{friendlyError(positionsQuery.error)}</p>
        ) : !rows || rows.length === 0 ? (
          <div className={styles.empty}>
            No positions yet — <Link href="/markets">browse markets →</Link>
          </div>
        ) : (
          <div className={styles.rows}>
            {rows.map((row) => {
              const { position: p, market: m } = row;
              const state = positionState(p, m);
              const chip = STATE_CHIP[state];
              const fixtureId = m ? Number(m.fixtureId) : null;
              const info = fixtureId !== null ? getFixtureInfo(fixtureId) : null;
              const question = m
                ? describeMarketPredicate(m, info ?? undefined)
                : `market ${shortPda(p.market)} (account not readable)`;
              return (
                <div key={p.pda} className={`card ${styles.row}`}>
                  <div className={styles.rowMain}>
                    <div className={styles.question}>
                      <Link href={`/market/${p.market}`}>{question}</Link>
                    </div>
                    <div className={styles.sub}>
                      {fixtureId !== null && <span>{fixtureDisplayName(fixtureId)}</span>}
                      <span>Side {p.side === 1 ? "A" : p.side === 2 ? "B" : `?${p.side}`}</span>
                      <span className={styles.amount}>{fmtUsdc(p.amount)} test-USDC staked</span>
                    </div>
                  </div>
                  <div className={styles.rowMeta}>
                    {m && (
                      <span className="pill" data-tone={statusTone(m.status)}>
                        {STATUS_NAMES[m.status] ?? m.status}
                      </span>
                    )}
                    <span className="pill" data-tone={chip.tone}>
                      {chip.label}
                    </span>
                    {state === "claimable" && (
                      <button
                        type="button"
                        className={`button ${styles.claimBtn}`}
                        onClick={() => onClaim(row)}
                        disabled={!!claiming}
                      >
                        {claiming === p.pda ? "Claiming…" : "Claim"}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {claimError && <p className={styles.error}>{claimError}</p>}
        {claimSig && (
          <p className={`muted ${styles.txNote}`}>
            Claim confirmed —{" "}
            <a href={explorerTxUrl(claimSig)} target="_blank" rel="noreferrer">
              view transaction on Solana Explorer ↗
            </a>
          </p>
        )}
      </section>

      {/* ---- Pending sealed orders ---- */}
      <section className={styles.section}>
        <h2>Pending sealed orders</h2>
        {ordersQuery.isPending ? (
          <div className={styles.rows} aria-hidden>
            <div className={`skeleton ${styles.skelRow}`} />
          </div>
        ) : ordersQuery.isError ? (
          <p className={styles.error}>{friendlyError(ordersQuery.error)}</p>
        ) : !pendingOrders || pendingOrders.length === 0 ? (
          <div className={styles.empty}>
            No pending sealed orders — matched and refunded orders leave this
            list. <Link href="/markets">Browse markets →</Link>
          </div>
        ) : (
          <div className={styles.rows}>
            {pendingOrders.map((o) => (
              <div key={o.pda} className={`card ${styles.row}`}>
                <div className={styles.rowMain}>
                  <div className={styles.question}>
                    <Link href={`/market/${o.market}`}>
                      Market <span className="mono">{shortPda(o.market)}</span>
                    </Link>
                  </div>
                  <div className={styles.sub}>
                    <span className={styles.amount}>
                      {fmtUsdc(o.collateralLocked)} test-USDC locked
                    </span>
                    <span>matched {fmtUsdc(o.matchedSize)}</span>
                    <span className={styles.hash} title={o.commitment}>
                      {o.commitment.slice(0, 12)}…
                    </span>
                  </div>
                </div>
                <div className={styles.rowMeta}>
                  <span className="pill" data-tone={orderStatusTone(o.status)}>
                    {ORDER_STATUS_NAMES[o.status] ?? o.status}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ---- Receipts ---- */}
      <section className={styles.section}>
        <h2>Receipts</h2>
        {positionsQuery.isPending ? (
          <div className={styles.rows} aria-hidden>
            <div className={`skeleton ${styles.skelRow}`} />
          </div>
        ) : receiptMarkets.length === 0 ? (
          <div className={styles.empty}>
            No settled positions yet — a verifiable settlement receipt appears
            here once a market you hold a position in settles.
          </div>
        ) : (
          <div className={styles.rows}>
            {receiptMarkets.map((row) => {
              const m = row.market!;
              const info = getFixtureInfo(Number(m.fixtureId));
              return (
                <div key={row.position.market} className={`card ${styles.row}`}>
                  <div className={styles.rowMain}>
                    <div className={styles.question}>
                      {describeMarketPredicate(m, info ?? undefined)}
                    </div>
                    <div className={styles.sub}>
                      <span>{fixtureDisplayName(Number(m.fixtureId))}</span>
                      <span>{STATUS_NAMES[m.status] ?? m.status}</span>
                    </div>
                  </div>
                  <div className={styles.rowMeta}>
                    <Link
                      href={`/receipt/${row.position.market}`}
                      className="button"
                      data-variant="ghost"
                    >
                      View verifiable receipt →
                    </Link>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <p className={styles.footNote}>
        All data on this page is live devnet state read from program{" "}
        <span className="mono">4LpMzq6…18MB</span> — nothing here is cached
        server-side or mocked.
      </p>
    </>
  );
}
