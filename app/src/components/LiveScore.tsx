"use client";

import { useEffect, useState } from "react";
import styles from "./LiveScore.module.css";

interface FixtureScore {
  fixtureId: number;
  p1Goals: number;
  p2Goals: number;
  seq: number;
  fetchedAt: number;
  source: "txline" | "unavailable";
}

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
