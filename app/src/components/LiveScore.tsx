"use client";

import { useEffect, useState } from "react";
import { useReferenceOdds } from "@/lib/hooks";
import styles from "./LiveScore.module.css";

import type { FixtureScore } from "@/lib/hooks";

// Real data only: polls our server-side proxy (app/src/app/api/scores/
// [fixtureId]/route.ts), which calls TxLINE's stat-validation endpoint with
// credentials that never reach the browser. TxLINE's free-tier (SL1) data
// only refreshes on the order of ~60s, so this is NOT a live/real-time feed
// -- it's disclosed as such in the UI rather than implying otherwise.
const POLL_MS = 20_000;

function formatKickoff(startTimeMs: number): string {
  const diffMs = startTimeMs - Date.now();
  if (diffMs <= 0) return "kicked off";
  const hours = Math.floor(diffMs / 3_600_000);
  const mins = Math.round((diffMs % 3_600_000) / 60_000);
  if (hours >= 24) return `kicks off in ${Math.floor(hours / 24)}d ${hours % 24}h`;
  if (hours > 0) return `kicks off in ${hours}h ${mins}m`;
  return `kicks off in ${mins}m`;
}

export function LiveScore({
  fixtureId,
  homeLabel,
  awayLabel,
  startTimeMs,
}: {
  fixtureId: number;
  homeLabel: string;
  awayLabel: string;
  startTimeMs?: number | null;
}) {
  const [score, setScore] = useState<FixtureScore | null>(null);
  const [error, setError] = useState(false);
  // Bookmaker 1X2 reference (TxLINE /odds/snapshot) — external context only,
  // never our market's price and never settlement; hidden when unpublished.
  const odds = useReferenceOdds(fixtureId);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const res = await fetch(`/api/scores/${fixtureId}`, { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as FixtureScore;
        if (!cancelled) {
          setScore(data);
          setError(false);
        }
      } catch {
        if (!cancelled) setError(true);
      }
    }
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [fixtureId]);

  const upcoming = typeof startTimeMs === "number" && startTimeMs > Date.now();
  const hasStarted = score !== null && score.seq > 1;
  const statusLabel = upcoming ? "Upcoming" : hasStarted ? "Score" : score ? "Not started" : "Loading…";

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <span className={styles.live}>
          <span className={styles.dot} data-on={score?.source === "txline" ? "true" : "false"} />
          {statusLabel}
        </span>
        {typeof startTimeMs === "number" && (
          <span className="muted">{formatKickoff(startTimeMs)}</span>
        )}
      </div>
      <div className={styles.score}>
        <span className={styles.team}>{homeLabel}</span>
        <span className={styles.digits}>
          {score ? `${score.p1Goals} : ${score.p2Goals}` : "– : –"}
        </span>
        <span className={styles.team}>{awayLabel}</span>
      </div>
      {score && hasStarted && score.p1Yellows + score.p2Yellows + score.p1Reds + score.p2Reds + score.p1Corners + score.p2Corners > 0 && (
        <div className={styles.statRow}>
          <span title="Yellow cards">🟨 {score.p1Yellows} – {score.p2Yellows}</span>
          {(score.p1Reds > 0 || score.p2Reds > 0) && <span title="Red cards">🟥 {score.p1Reds} – {score.p2Reds}</span>}
          <span title="Corners">⛳ {score.p1Corners} – {score.p2Corners}</span>
        </div>
      )}
      {odds.data?.source === "txline" && odds.data.homePct !== null && (
        <div className={styles.statRow} title={`Bookmaker: ${odds.data.bookmaker ?? "n/a"} — implied 1X2 probabilities from TxLINE's odds feed. Reference only; ONYX prices come from the pool.`}>
          <span className="muted">bookmaker ref:</span>
          <span>{homeLabel} {odds.data.homePct.toFixed(0)}%</span>
          {odds.data.drawPct !== null && <span>draw {odds.data.drawPct.toFixed(0)}%</span>}
          {odds.data.awayPct !== null && <span>{awayLabel} {odds.data.awayPct.toFixed(0)}%</span>}
        </div>
      )}
      <div className={styles.note}>
        <span className="pill">
          {error || score?.source === "unavailable"
            ? "TxLINE score unavailable"
            : upcoming
              ? "Match hasn't started — score will be 0:0 until kickoff"
              : "Live from TxLINE"}
        </span>
        <span className="muted mono" style={{ fontSize: "0.72rem" }}>
          {score ? `fetched ${new Date(score.fetchedAt).toLocaleTimeString()} · ` : ""}
          TxLINE SL1 cadence (~60s) — not real-time
        </span>
      </div>
    </div>
  );
}
