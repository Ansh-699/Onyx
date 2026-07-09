import { MarketsGrid } from "./MarketsGrid";

// Thin server shell: the grid itself is a client component that polls live
// devnet state via useMarkets() (react-query, ~20s refresh, keepPreviousData)
// and shows fixed-height skeletons on first paint — so there's no bigint
// serialization across the server->client boundary and zero layout shift.
// All of the old lobby's honesty logic (placeholder-fixture filter,
// duplicate-predicate collapsing, disclosure footers) lives in MarketsGrid.

export default function LobbyPage() {
  return (
    <>
      <h1>World Cup markets</h1>
      <p className="muted">
        Live on-chain markets read directly from the ONYX program on devnet —
        every card below is a real{" "}
        <span className="mono">getProgramAccounts</span> result, not mock
        data. Settlement is trustless: a CPI into TxLINE&apos;s{" "}
        <span className="mono">validate_stat</span>.
      </p>
      <MarketsGrid />
    </>
  );
}
