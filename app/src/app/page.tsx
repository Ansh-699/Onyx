// Landing page. Placeholder shell — being replaced by the full marketing
// landing (hero, pillars, live stats) in this same excellence pass; kept
// minimal-but-functional so the app is runnable at every step.

import Link from "next/link";

export default function LandingPage() {
  return (
    <div style={{ textAlign: "center", paddingTop: 96 }}>
      <h1 style={{ fontSize: "2.2rem" }}>Verifiable prediction markets on Solana</h1>
      <p className="muted" style={{ maxWidth: 560, margin: "16px auto 32px" }}>
        Sealed, MEV-proof orders. Trustless oracle settlement. Every outcome
        independently verifiable on-chain.
      </p>
      <Link href="/markets" className="button">
        Launch app →
      </Link>
    </div>
  );
}
