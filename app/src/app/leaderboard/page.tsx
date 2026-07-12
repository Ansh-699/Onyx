"use client";

// Leaderboard — real on-chain aggregates per trader (see /api/leaderboard).
// Ranked by capital deployed + withdrawn, the figures that actually live
// on-chain; P&L would require per-trade cost basis the program doesn't
// store, so it isn't shown rather than approximated.

import { useQuery } from "@tanstack/react-query";
import { explorerAddressUrl } from "@/lib/onchain";
import styles from "./leaderboard.module.css";

interface Row {
  owner: string;
  markets: number;
  deployed: string;
  withdrawn: string;
}

const fmt = (raw: string) => (Number(BigInt(raw)) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 });
const medal = (i: number) => (i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}`);

export default function LeaderboardPage() {
  const { data, isPending, isError } = useQuery<{ rows: Row[] }>({
    queryKey: ["leaderboard"],
    queryFn: async () => {
      const res = await fetch("/api/leaderboard", { cache: "no-store" });
      if (!res.ok) throw new Error(`leaderboard ${res.status}`);
      return res.json();
    },
    staleTime: 5 * 60_000,
  });

  return (
    <div className={styles.page}>
      <h1>Leaderboard</h1>
      <p className="muted">
        Every row is aggregated from real on-chain position accounts — capital currently deployed in markets
        (deposits + outcome tokens at face value) plus everything already withdrawn.
      </p>

      <div className={`card ${styles.tableCard}`}>
        {isPending ? (
          <div className="skeleton" style={{ height: 300 }} />
        ) : isError || !data ? (
          <p className="muted">Couldn&apos;t reach devnet to build the leaderboard — try again shortly.</p>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>#</th>
                <th>Trader</th>
                <th>Markets</th>
                <th>Deployed (USDC)</th>
                <th>Withdrawn (USDC)</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r, i) => (
                <tr key={r.owner}>
                  <td className={styles.rank}>{medal(i)}</td>
                  <td className="mono">
                    <a href={explorerAddressUrl(r.owner)} target="_blank" rel="noreferrer">
                      {r.owner.slice(0, 4)}…{r.owner.slice(-4)} ↗
                    </a>
                  </td>
                  <td>{r.markets}</td>
                  <td className="mono">{fmt(r.deployed)}</td>
                  <td className="mono">{fmt(r.withdrawn)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className={styles.note}>
        Includes the disclosed seeded market-making wallets — every figure is a real devnet account, verifiable
        via the explorer links.
      </p>
    </div>
  );
}
