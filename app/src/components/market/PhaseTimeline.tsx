"use client";

// Sealed-market lifecycle: Commit → Reveal → Match → Settled.
// Derived ONLY from market.phase / market.status / the on-chain window
// timestamps — never guessed. The per-second countdown ticks inside the
// <Countdown> leaf so this component (and the page) only re-render on the
// 8s market poll.

import type { ReactNode } from "react";
import {
  PHASE_MATCHED,
  STATUS_SETTLED,
  STATUS_CLAIMED,
} from "@/lib/onchain";
import { Countdown } from "./Countdown";
import styles from "./PhaseTimeline.module.css";

type StepState = "done" | "current" | "todo";

export function PhaseTimeline({
  phase,
  status,
  commitEndTs,
  revealEndTs,
}: {
  phase: number;
  status: number;
  commitEndTs: bigint;
  revealEndTs: bigint;
}) {
  const now = Math.floor(Date.now() / 1000);
  const commitEnd = Number(commitEndTs);
  const revealEnd = Number(revealEndTs);
  const settled = status === STATUS_SETTLED || status === STATUS_CLAIMED;

  // Index of the step currently in progress; 4 = everything (incl. settle)
  // is finished. The on-chain phase byte only advances when a transaction
  // touches the market, so the clock (window timestamps) takes precedence.
  let current: number;
  if (settled) current = 4;
  else if (phase === PHASE_MATCHED) current = 3;
  else if (now >= revealEnd) current = 2;
  else if (now >= commitEnd) current = 1;
  else current = 0;

  const steps: { label: string; sub: ReactNode }[] = [
    {
      label: "Commit",
      sub:
        current === 0 ? (
          <>
            closes in <Countdown targetSec={commitEnd} />
          </>
        ) : null,
    },
    {
      label: "Reveal",
      sub:
        current === 1 ? (
          <>
            closes in <Countdown targetSec={revealEnd} />
          </>
        ) : null,
    },
    {
      label: "Match",
      sub: current === 2 ? "batch ready to run" : null,
    },
    {
      label: "Settled",
      sub: current === 3 ? "awaiting validate_stat" : settled ? "via validate_stat" : null,
    },
  ];

  return (
    <div className={`card ${styles.wrap}`}>
      <ol className={styles.track}>
        {steps.map((step, i) => {
          const state: StepState = i < current ? "done" : i === current ? "current" : "todo";
          return (
            <li key={step.label} className={styles.step} data-state={state}>
              <span className={styles.dot} aria-hidden>
                {state === "done" ? "✓" : i + 1}
              </span>
              <span className={styles.label}>{step.label}</span>
              <span className={styles.sub}>{step.sub}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
