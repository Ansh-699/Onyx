"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./LiveScore.module.css";

interface ScoreEvent {
  minute: number;
  home: number;
  away: number;
  note: string;
  tsMs: number;
}

/**
 * Live score / stat area.
 *
 * PLACEHOLDER: the real wiring connects to TxLINE `GET /scores/stream` (SSE)
 * via an EventSource proxied through our backend (so JWT + X-Api-Token stay
 * server-side). Until that's wired, this simulates the event cadence so the
 * market page shows a live-updating surface.
 */
export function LiveScore({
  homeLabel,
  awayLabel,
}: {
  homeLabel: string;
  awayLabel: string;
}) {
  const [event, setEvent] = useState<ScoreEvent>({
    minute: 0,
    home: 0,
    away: 0,
    note: "Kickoff",
    tsMs: Date.now(),
  });
  const [connected, setConnected] = useState(false);
  const tick = useRef(0);

  useEffect(() => {
    // Simulated SSE stream. Replace with:
    //   const es = new EventSource("/api/scores/stream?fixtureId=...");
    //   es.onmessage = (e) => setEvent(JSON.parse(e.data));
    setConnected(true);
    const notes = [
      "Shot on target",
      "Corner",
      "Goal!",
      "Yellow card",
      "Possession swing",
      "Save",
    ];
    const id = setInterval(() => {
      tick.current += 1;
      setEvent((prev) => {
        const scored = tick.current % 5 === 0;
        return {
          minute: Math.min(90, prev.minute + 3),
          home: prev.home + (scored && tick.current % 2 === 0 ? 1 : 0),
          away: prev.away + (scored && tick.current % 2 === 1 ? 1 : 0),
          note: scored ? "Goal!" : notes[tick.current % notes.length],
          tsMs: Date.now(),
        };
      });
    }, 2500);
    return () => {
      clearInterval(id);
      setConnected(false);
    };
  }, []);

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <span className={styles.live}>
          <span
            className={styles.dot}
            data-on={connected ? "true" : "false"}
          />
          {connected ? "LIVE (simulated SSE)" : "disconnected"}
        </span>
        <span className="muted">{event.minute}&apos;</span>
      </div>
      <div className={styles.score}>
        <span className={styles.team}>{homeLabel}</span>
        <span className={styles.digits}>
          {event.home}&nbsp;:&nbsp;{event.away}
        </span>
        <span className={styles.team}>{awayLabel}</span>
      </div>
      <div className={styles.note}>
        <span className="pill">{event.note}</span>
        <span className="muted mono">
          ts {event.tsMs} (ms) · epochDay{" "}
          {Math.floor(event.tsMs / 86_400_000)}
        </span>
      </div>
    </div>
  );
}
