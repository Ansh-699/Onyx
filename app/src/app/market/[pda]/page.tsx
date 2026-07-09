import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getMarket,
  STATUS_NAMES,
  OUTCOME_NAMES,
  CMP_SYMBOLS,
  PHASE_NONE,
  explorerAddressUrl,
} from "@/lib/onchain";
import { LiveScore } from "@/components/LiveScore";
import { SealedOrderPanel } from "@/components/SealedOrderPanel";
import { SettleClaimPanel } from "@/components/SettleClaimPanel";

export const dynamic = "force-dynamic";

export default async function MarketPage({
  params,
}: {
  params: Promise<{ pda: string }>;
}) {
  const { pda } = await params;
  const market = await getMarket(pda);
  if (!market) notFound();

  const total = market.totalSideA + market.totalSideB;
  const yesPct = total > 0n ? Number((market.totalSideA * 100n) / total) : 50;
  const settled = market.status >= 4;

  return (
    <>
      <p>
        <Link href="/">← Lobby</Link>
      </p>
      <h1>
        stat[{market.statAKey}] {CMP_SYMBOLS[market.predicate] ?? "?"}{" "}
        {market.threshold.toString()}
      </h1>
      <p className="muted">
        fixture #{market.fixtureId.toString()} · live on-chain market (devnet)
      </p>
      <p className="mono muted">
        market{" "}
        <a href={explorerAddressUrl(market.pda)} target="_blank" rel="noreferrer">
          {market.pda}
        </a>
      </p>

      <h2>Live</h2>
      <LiveScore homeLabel={`Fixture #${market.fixtureId}`} awayLabel="TxLINE" />

      <h2>Market (on-chain state)</h2>
      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <div>
            <div className="muted" style={{ fontSize: "0.8rem" }}>
              Status
            </div>
            <div style={{ fontWeight: 600 }}>
              {STATUS_NAMES[market.status] ?? market.status}
              {settled && (
                <span className="pill" style={{ marginLeft: "0.5rem" }}>
                  outcome: {OUTCOME_NAMES[market.outcome] ?? market.outcome}
                </span>
              )}
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div className="muted" style={{ fontSize: "0.8rem" }}>
              Deadline (unix secs)
            </div>
            <div className="mono">{market.deadline.toString()}</div>
          </div>
        </div>

        <div
          style={{
            marginTop: "1rem",
            height: 10,
            borderRadius: 999,
            overflow: "hidden",
            background: "var(--red)",
          }}
        >
          <div
            style={{
              width: `${yesPct}%`,
              height: "100%",
              background: "var(--green)",
            }}
          />
        </div>
        <div
          className="muted"
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: "0.8rem",
            marginTop: "0.4rem",
          }}
        >
          <span>Side A {market.totalSideA.toString()}</span>
          <span>{yesPct}%</span>
          <span>Side B {market.totalSideB.toString()}</span>
        </div>
      </div>

      {market.phase !== PHASE_NONE && (
        <>
          <h2>Sealed order intent</h2>
          <SealedOrderPanel market={market} />
        </>
      )}

      <h2>Settlement</h2>
      <p className="muted">
        {settled
          ? "This market has been settled trustlessly via a CPI to validate_stat against the anchored daily scores root."
          : "At the deadline, ONYX settles this market via a CPI to validate_stat against the anchored daily scores root."}{" "}
        Anyone can independently verify the outcome:
      </p>
      <SettleClaimPanel market={market} />
      <p style={{ marginTop: "1rem" }}>
        <Link href={`/receipt/${market.pda}`} className="button">
          View verifiable receipt →
        </Link>
      </p>
    </>
  );
}
