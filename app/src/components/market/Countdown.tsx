"use client";

// Self-ticking countdown LEAF. The 1s interval lives here so parent
// components (and the whole market page) don't re-render every second —
// only this <span> does.

import { useEffect, useState } from "react";

function fmt(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s}s`;
}

export function Countdown({
  targetSec,
  doneText = "closed",
}: {
  targetSec: number;
  doneText?: string;
}) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  const left = targetSec - now;
  return <span className="mono">{left <= 0 ? doneText : fmt(left)}</span>;
}
