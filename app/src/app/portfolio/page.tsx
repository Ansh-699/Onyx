"use client";

// Portfolio — every row on this page is a live devnet read (getProgramAccounts
// on the ONYX program filtered by this wallet), never mock data. Wallet-gated:
// a stable placeholder renders until the client has mounted so the server and
// first client paint always agree (no hydration mismatch, no flash).

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction } from "@solana/web3.js";
import { useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import {
  type OnChainMarket,
  type OnChainAmmPosition,
  getMarket,
  getConfigUsdcMint,
  listAmmPositionsForOwner,
  STATUS_NAMES,
  STATUS_SETTLED,
  STATUS_CLAIMED,
  OUTCOME_SIDE_A,
  SETTLE_GRACE_SEC,
  ORDER_STATUS_NAMES,
  TRADING_STATUS_NAMES,
  TRADING_STATUS_LOCKED,
  TRADING_STATUS_REVEALED,
  TRADING_STATUS_MATCHED,
  explorerTxUrl,
} from "@/lib/onchain";
import {
  type OnChainPosition,
  type OwnedTradingAccount,
  listPositionsByOwner,
  listSealedOrdersByOwner,
  listTradingAccountsByOwner,
} from "@/lib/positions";
import { buildClaimIx } from "@/lib/instructions";
import { spotPriceScaled } from "@/lib/ammMath";
import { friendlyError } from "@/lib/errors";
import { sendViaWallet } from "@/lib/tx";
import { describeMarketPredicate } from "@/lib/statKeys";
import { getFixtureInfo, fixtureDisplayName, primeLiveFixtures } from "@/lib/fixtureMeta";
import { useLiveFixtures, useAmmPoolMarkets } from "@/lib/hooks";
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

function tradingStatusTone(status: number): string | undefined {
  if (status === TRADING_STATUS_LOCKED) return "amber";
  if (status === TRADING_STATUS_REVEALED) return "accent";
  if (status === TRADING_STATUS_MATCHED) return "green";
  return undefined;
}

function canWithdrawTa(t: OwnedTradingAccount): boolean {
  return t.available > 0n || (t.status === TRADING_STATUS_MATCHED && !t.claimedWinnings);
}

// ---- page ----

export default function PortfolioPage() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const { connection } = useConnection();
  const { publicKey, connected, signTransaction } = useWallet();
  const queryClient = useQueryClient();

  const owner = publicKey?.toBase58() ?? null;
  const ready = mounted && connected && !!publicKey;
  // Live TxLINE fixture names for the getFixtureInfo calls below.
  const liveFixtures = useLiveFixtures();
  primeLiveFixtures(liveFixtures.data);

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

  // Fast trading (Ephemeral Rollup) accounts, across every market — see
  // listTradingAccountsByOwner's own doc comment for why this can't be a
  // simple base-only getProgramAccounts scan like the two queries above.
  const tradingAccountsQuery = useQuery({
    queryKey: ["myTradingAccounts", owner],
    queryFn: () => listTradingAccountsByOwner(publicKey!),
    refetchInterval: 15_000,
    placeholderData: keepPreviousData,
    enabled: ready,
  });

  // AMM positions (continuous-trading markets). Base owner-scan: a position
  // currently delegated to the ER is temporarily absent here (owned by the
  // Delegation Program) and reappears on undelegation — its live state is on
  // the market page, which routes reads to the ER. Labeled in the footer.
  const ammPositionsQuery = useQuery<{ position: OnChainAmmPosition; market: OnChainMarket | null }[]>({
    queryKey: ["myAmmPositions", owner],
    queryFn: async () => {
      const positions = await listAmmPositionsForOwner(publicKey!);
      const marketPdas = [...new Set(positions.map((p) => p.market))];
      const fetched = await Promise.all(marketPdas.map((pda) => getMarket(pda)));
      const byPda = new Map(marketPdas.map((pda, i) => [pda, fetched[i] ?? null]));
      return positions
        .filter((p) => p.usdcAvailable > 0n || p.tokensA > 0n || p.tokensB > 0n || !p.redeemed)
        .map((position) => ({ position, market: byPda.get(position.market) ?? null }));
    },
    refetchInterval: 15_000,
    placeholderData: keepPreviousData,
    enabled: ready,
  });

  // Live pool prices for the positions' markets — token holdings get valued
  // at the price they could actually be sold at right now.
  const ammMarketPdas = useMemo(
    () => [...new Set((ammPositionsQuery.data ?? []).map((r) => r.position.market))],
    [ammPositionsQuery.data],
  );
  const ammPools = useAmmPoolMarkets(ammMarketPdas.length > 0 ? ammMarketPdas : undefined);

  /** Value a position at the pool's live price (usdc + tokens marked to market). */
  const positionValue = (p: OnChainAmmPosition): bigint => {
    const pool = ammPools.data?.get(p.market);
    let v = p.usdcAvailable;
    if (pool && pool.reserveA + pool.reserveB > 0n) {
      const priceA = spotPriceScaled(pool.reserveA, pool.reserveB);
      v += (p.tokensA * priceA + p.tokensB * (1_000_000n - priceA)) / 1_000_000n;
    }
    return v;
  };

  // AMM summary strip: totals across every position (real on-chain figures;
  // token values are marked at live pool prices, labeled as such).
  const ammSummary = useMemo(() => {
    const rows = ammPositionsQuery.data ?? [];
    const now = Math.floor(Date.now() / 1000);
    let atWork = 0n;
    let withdrawable = 0n;
    let withdrawn = 0n;
    let open = 0;
    for (const { position: p, market: m } of rows) {
      withdrawn += p.withdrawn;
      const isSettled = !!m && (m.status === STATUS_SETTLED || m.status === STATUS_CLAIMED);
      const isExpired = !!m && !isSettled && now > Number(m.deadline) + SETTLE_GRACE_SEC;
      if (isSettled || isExpired) {
        if (!p.redeemed) {
          const winning = isSettled ? (m!.outcome === OUTCOME_SIDE_A ? p.tokensA : p.tokensB) : 0n;
          const setTokens = p.tokensA < p.tokensB ? p.tokensA : p.tokensB;
          withdrawable += p.usdcAvailable + (isSettled ? winning : setTokens);
        }
      } else {
        atWork += positionValue(p);
        open++;
      }
    }
    return { atWork, withdrawable, withdrawn, open };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ammPositionsQuery.data, ammPools.data]);

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
      if (!signTransaction) throw new Error("This wallet can't sign transactions — reconnect and try again.");
      const tx = new Transaction().add(ix);
      const sig = await sendViaWallet(connection, tx, publicKey, signTransaction);
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
        Your fast-trade accounts, positions, and sealed orders, read live from
        the ONYX program on devnet — every row is a real on-chain account for
        your wallet (routed to whichever ledger, base or Ephemeral Rollup,
        currently holds each market's state), refreshed every ~15s.
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
  const totalStaked = rows ? rows.reduce((acc, r) => acc + r.position.amount, 0n) : 0n;
  const openCount = rows ? rows.filter((r) => positionState(r.position, r.market) === "open").length : 0;
  const claimableCount = rows ? rows.filter((r) => positionState(r.position, r.market) === "claimable").length : 0;
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

  const tas = tradingAccountsQuery.data;

  return (
    <>
      {header}

      {rows && rows.length > 0 && (
        <div className={`card ${styles.summary}`}>
          <div className={styles.summaryStat}>
            <span className={styles.summaryValue}>{openCount}</span>
            <span className={styles.summaryLabel}>Open positions</span>
          </div>
          <div className={styles.summaryStat}>
            <span className={styles.summaryValue} data-tone={claimableCount > 0 ? "green" : undefined}>
              {claimableCount}
            </span>
            <span className={styles.summaryLabel}>Claimable now</span>
          </div>
          <div className={styles.summaryStat}>
            <span className={styles.summaryValue}>{fmtUsdc(totalStaked)}</span>
            <span className={styles.summaryLabel}>Total staked (test-USDC)</span>
          </div>
        </div>
      )}

      {/* ---- Your positions (AMM, the flagship flow) — always first ---- */}
      <section className={styles.section}>
        <h2>Your positions · trade-anytime markets</h2>

        {/* summary strip: real on-chain totals; token values marked at live pool prices */}
        {ammPositionsQuery.data && ammPositionsQuery.data.length > 0 && (
          <div className={`card ${styles.summary}`}>
            <div className={styles.summaryStat}>
              <span className={styles.summaryValue}>{fmtUsdc(ammSummary.atWork)}</span>
              <span className={styles.summaryLabel}>In open markets (tUSDC, at pool price)</span>
            </div>
            <div className={styles.summaryStat}>
              <span className={styles.summaryValue} data-tone={ammSummary.withdrawable > 0n ? "green" : undefined}>
                {fmtUsdc(ammSummary.withdrawable)}
              </span>
              <span className={styles.summaryLabel}>Ready to withdraw</span>
            </div>
            <div className={styles.summaryStat}>
              <span className={styles.summaryValue}>{fmtUsdc(ammSummary.withdrawn)}</span>
              <span className={styles.summaryLabel}>Withdrawn to date</span>
            </div>
            <div className={styles.summaryStat}>
              <span className={styles.summaryValue}>{ammSummary.open}</span>
              <span className={styles.summaryLabel}>Open positions</span>
            </div>
          </div>
        )}

        {ammPositionsQuery.isPending ? (
          <div className={styles.rows} aria-hidden>
            <div className={`skeleton ${styles.skelRow}`} />
          </div>
        ) : ammPositionsQuery.isError ? (
          <p className={styles.error}>{friendlyError(ammPositionsQuery.error)}</p>
        ) : !ammPositionsQuery.data || ammPositionsQuery.data.length === 0 ? (
          <div className={styles.empty}>
            No positions yet — <Link href="/markets">browse markets →</Link>
          </div>
        ) : (
          <div className={styles.rows}>
            {ammPositionsQuery.data.map(({ position: p, market: m }) => {
              const nowSec = Math.floor(Date.now() / 1000);
              const settled = !!m && (m.status === STATUS_SETTLED || m.status === STATUS_CLAIMED);
              // Program-mirrored expiry gate: never-settled market past deadline + grace
              // refunds deposits + min(both token sides); directional residual is lost.
              const expired = !!m && !settled && nowSec > Number(m.deadline) + SETTLE_GRACE_SEC;
              const winning = settled ? (m!.outcome === OUTCOME_SIDE_A ? p.tokensA : p.tokensB) : 0n;
              const setTokens = p.tokensA < p.tokensB ? p.tokensA : p.tokensB;
              const redeemable = p.usdcAvailable + (p.redeemed ? 0n : settled ? winning : expired ? setTokens : 0n);
              const pool = ammPools.data?.get(p.market);
              const priceA = pool && pool.reserveA + pool.reserveB > 0n ? spotPriceScaled(pool.reserveA, pool.reserveB) : null;
              const yesCents = priceA !== null ? Math.round(Number(priceA) / 10_000) : null;
              const value = positionValue(p);
              const closesIn = m && !settled && Number(m.deadline) > nowSec ? Number(m.deadline) - nowSec : null;
              const closesLabel =
                closesIn !== null
                  ? closesIn > 86_400
                    ? `closes in ${Math.floor(closesIn / 86_400)}d ${Math.floor((closesIn % 86_400) / 3_600)}h`
                    : closesIn > 3_600
                      ? `closes in ${Math.floor(closesIn / 3_600)}h ${Math.floor((closesIn % 3_600) / 60)}m`
                      : `closes in ${Math.max(1, Math.floor(closesIn / 60))}m`
                  : null;
              return (
                <div key={p.pda} className={`card ${styles.row}`}>
                  <div className={styles.rowMain}>
                    <div className={styles.question}>
                      <Link href={`/market/${p.market}`}>
                        {m ? describeMarketPredicate(m, getFixtureInfo(Number(m.fixtureId)) ?? undefined) : <>Market <span className="mono">{shortPda(p.market)}</span></>}
                      </Link>
                    </div>
                    <div className={styles.sub}>
                      {p.tokensA > 0n && (
                        <span className={styles.holdYes}>
                          {fmtUsdc(p.tokensA)} YES{yesCents !== null && ` @ ${yesCents}¢`}
                        </span>
                      )}
                      {p.tokensB > 0n && (
                        <span className={styles.holdNo}>
                          {fmtUsdc(p.tokensB)} NO{yesCents !== null && ` @ ${100 - yesCents}¢`}
                        </span>
                      )}
                      {p.usdcAvailable > 0n && <span>{fmtUsdc(p.usdcAvailable)} tUSDC to spend</span>}
                      {p.withdrawn > 0n && <span>withdrawn {fmtUsdc(p.withdrawn)}</span>}
                    </div>
                    <div className={styles.sub}>
                      {!settled && !expired && value > 0n && (
                        <span className={styles.amount} title="Deposits plus tokens valued at the pool's live price — what selling everything right now would return before fees/slippage.">
                          worth ≈{fmtUsdc(value)} tUSDC at pool price
                        </span>
                      )}
                      {closesLabel && <span>{closesLabel}</span>}
                      <a
                        className="mono"
                        href={`https://explorer.solana.com/address/${p.pda}?cluster=devnet`}
                        target="_blank"
                        rel="noreferrer"
                        title="Your position account on-chain"
                      >
                        {shortPda(p.pda)} ↗
                      </a>
                    </div>
                  </div>
                  <div className={styles.rowMeta}>
                    <span className="pill" data-tone={settled ? "green" : expired ? "amber" : "accent"}>
                      {p.redeemed ? "Redeemed" : settled ? "Redeemable" : expired ? "Refundable (expired)" : m ? (STATUS_NAMES[m.status] ?? "Open") : "Open"}
                    </span>
                    {settled && !p.redeemed && (
                      <span className="pill" data-tone={winning > 0n ? "green" : "red"}>
                        {winning > 0n ? `won · ${fmtUsdc(winning)} redeems 1:1` : "side lost"}
                      </span>
                    )}
                    {!p.redeemed && redeemable > 0n && (
                      <Link href={`/market/${p.market}`} className="button" data-variant="ghost">
                        Withdraw →
                      </Link>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <p className={styles.txNote} style={{ marginTop: 8 }}>
          Token values are marked at each pool&apos;s live price — actual sale proceeds shift with slippage and
          the 1% pool fee. Every figure above is a live on-chain read.
        </p>
      </section>

      {/* ---- Sealed fast-trade accounts (advanced; ER is a speed layer, not
          a separate product — hidden entirely when the wallet has none) ---- */}
      {(tradingAccountsQuery.isError || (tas && tas.length > 0)) && (
        <section className={styles.section}>
          <h2>Sealed fast-trade accounts · advanced</h2>
          {tradingAccountsQuery.isError ? (
            <p className={styles.error}>{friendlyError(tradingAccountsQuery.error)}</p>
          ) : (
            <div className={styles.rows}>
              {tas!.map((t) => (
                <div key={t.pda} className={`card ${styles.row}`}>
                  <div className={styles.rowMain}>
                    <div className={styles.question}>
                      <Link href={`/market/${t.marketPda}`}>
                        Market <span className="mono">{shortPda(t.marketPda)}</span>
                      </Link>
                    </div>
                    <div className={styles.sub}>
                      <span className={styles.amount}>{fmtUsdc(t.deposited)} test-USDC deposited</span>
                      {t.locked > 0n && <span>{fmtUsdc(t.locked)} locked</span>}
                      {t.status === TRADING_STATUS_MATCHED && <span>matched {fmtUsdc(t.matchedSize)}</span>}
                      {t.available > 0n && <span className={styles.amount}>{fmtUsdc(t.available)} withdrawable</span>}
                    </div>
                  </div>
                  <div className={styles.rowMeta}>
                    <span className="pill" data-tone={tradingStatusTone(t.status)}>
                      {TRADING_STATUS_NAMES[t.status] ?? t.status}
                    </span>
                    {canWithdrawTa(t) && (
                      <Link href={`/market/${t.marketPda}`} className="button" data-variant="ghost">
                        Go withdraw →
                      </Link>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* ---- Parimutuel stakes (legacy join_market flow) — hidden when empty ---- */}
      {(positionsQuery.isError || (rows && rows.length > 0)) && (
      <section className={styles.section}>
        <h2>Parimutuel stakes · legacy markets</h2>
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
      )}

      {/* ---- Pending sealed orders (advanced) — hidden when empty ---- */}
      {(ordersQuery.isError || (pendingOrders && pendingOrders.length > 0)) && (
      <section className={styles.section}>
        <h2>Pending sealed orders · advanced</h2>
        {ordersQuery.isError ? (
          <p className={styles.error}>{friendlyError(ordersQuery.error)}</p>
        ) : !pendingOrders || pendingOrders.length === 0 ? null : (
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
      )}

      {/* ---- Receipts — hidden when empty ---- */}
      {receiptMarkets.length > 0 && (
      <section className={styles.section}>
        <h2>Receipts</h2>
        {positionsQuery.isPending ? (
          <div className={styles.rows} aria-hidden>
            <div className={`skeleton ${styles.skelRow}`} />
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
      )}

      <p className={styles.footNote}>
        All data on this page is live devnet state read from program{" "}
        <span className="mono">4LpMzq6…18MB</span> — nothing here is cached
        server-side or mocked.
      </p>
    </>
  );
}
