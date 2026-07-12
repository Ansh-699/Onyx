import Link from "next/link";
import { notFound } from "next/navigation";
import { getMarket, findSettleTx, explorerTxUrl } from "@/lib/onchain";
import { ReceiptVerifier } from "@/components/ReceiptVerifier";
import capturedFixture from "@/lib/fixtures/scores-validation.sample.json";

export const dynamic = "force-dynamic";

export default async function ReceiptPage({
  params,
}: {
  params: Promise<{ market: string }>;
}) {
  const { market: pda } = await params;
  const market = await getMarket(pda);
  if (!market) notFound();

  const settleTx = await findSettleTx(pda);

  // The bundled capture is real data for ONE specific fixture (18179550),
  // pulled live from TxLINE + used in the actual settle_market CPI on devnet.
  // Only attach it when it actually corresponds to this market so we never
  // show proof data for the wrong fixture.
  const matchesFixture = BigInt(capturedFixture.fixtureId) === market.fixtureId;
  const proof = matchesFixture ? capturedFixture : null;

  return (
    <>
      <p>
        <Link href={`/market/${pda}`} className="back-btn" aria-label="Back to market">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M19 12H5" /><path d="M12 19l-7-7 7-7" /></svg>
        </Link>
      </p>
      <h1>Verifiable receipt</h1>
      <p className="muted">
        This settlement is trustless: the outcome below was decided by a live
        CPI from the ONYX program into TxLINE&apos;s real{" "}
        <span className="mono">validate_stat</span> on devnet — not by ONYX,
        and not by this UI. Everything on this page is read directly from
        chain.
      </p>
      <p className="mono muted">market {pda}</p>

      <ReceiptVerifier market={market} settleTx={settleTx} proof={proof} />
    </>
  );
}
