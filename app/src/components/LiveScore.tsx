"use client";

import { useReferenceOdds, useScore, useScoreStreamLive } from "@/lib/hooks";
import styles from "./LiveScore.module.css";

// Real data only, delivered two ways: a server-side SSE bridge to TxLINE's
// /scores/stream pushes updates the moment TxLINE publishes them (useScore
// invalidates on every event), with a 20s poll as fallback. Credentials
// never reach the browser. The remaining latency floor is TxLINE's own SL1
// publish cadence (~60s during live play) — disclosed in the caption
// rather than implying tick-by-tick data we don't have.

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
  // SSE-pushed + poll-fallback score (see lib/hooks.ts useScore).
  const scoreQuery = useScore(fixtureId);
  const score = scoreQuery.data ?? null;
  const error = scoreQuery.isError;
  const streamLive = useScoreStreamLive();
  // Bookmaker 1X2 reference (TxLINE /odds/snapshot) — external context only,
  // never our market's price and never settlement; hidden when unpublished.
  const odds = useReferenceOdds(fixtureId);

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
          {score ? `updated ${new Date(score.fetchedAt).toLocaleTimeString()} · ` : ""}
          {streamLive ? "⚡ live push (SSE)" : "20s poll"} · TxLINE publishes ~60s (SL1 tier)
        </span>
      </div>
    </div>
  );
}
