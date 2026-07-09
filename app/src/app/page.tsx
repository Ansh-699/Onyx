import Link from "next/link";
import { listMarkets, STATUS_NAMES, OUTCOME_NAMES, STATUS_SETTLED, STATUS_CLAIMED } from "@/lib/onchain";
import { describeMarketPredicate, rawPredicateText } from "@/lib/statKeys";
import { getFixtureInfo, fixtureDisplayName } from "@/lib/fixtureMeta";
import styles from "./lobby.module.css";

export const dynamic = "force-dynamic"; // always read live devnet state, never cache

// Throwaway fixture ids used for on-chain testing this build (ER/PER/sealed-
// order de-risk spikes, verify-flow.ts runs, etc.) -- never real TxLINE
// fixtures. TxLINE's real fixture ids are 8-digit numbers with no fixed
// pattern (e.g. 18179550); every throwaway id used in this repo happens to
// live in the 900000000-900000999 range, so that's what's filtered here.
// This is purely a lobby display filter -- the accounts are still real and
// on-chain, `listMarkets()` still returns them, nothing is deleted.
function isPlaceholderFixture(fixtureId: bigint): boolean {
  return fixtureId >= 900_000_000n && fixtureId <= 900_000_999n;
}

// Earlier dev/demo runs opened several markets with the IDENTICAL predicate
// on fixture 18179550 (same statA/statB/op/predicate/threshold, different
// deadlines -> different PDAs) before this build had a varied predicate set.
// Rather than hide real on-chain accounts, collapse same-predicate duplicates
// into one row (preferring the one that actually got Settled/Claimed, since
// that's the one demonstrating trustless settlement) and disclose the rest.
function predicateKey(m: { statAKey: number; statBKey: number; op: number; predicate: number; threshold: bigint }): string {
  return `${m.statAKey}|${m.statBKey}|${m.op}|${m.predicate}|${m.threshold}`;
}
function statusRank(status: number): number {
  if (status === STATUS_CLAIMED) return 3;
  if (status === STATUS_SETTLED) return 2;
  return 1;
}

export default async function LobbyPage() {
  const allMarkets = await listMarkets();
  const markets = allMarkets.filter((m) => !isPlaceholderFixture(m.fixtureId));
  const hiddenCount = allMarkets.length - markets.length;

  const byFixture = new Map<string, typeof markets>();
  for (const m of markets) {
    const key = m.fixtureId.toString();
    const list = byFixture.get(key) ?? [];
    list.push(m);
    byFixture.set(key, list);
  }

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

      {markets.length === 0 ? (
        <p className="muted" style={{ marginTop: "1.5rem" }}>
          No markets found on devnet yet for program {""}
          <span className="mono">4LpMzq6…18MB</span>. Run{" "}
          <span className="mono">bun run services/ingestion/src/l0_loop_test.ts</span>{" "}
          to create one.
        </p>
      ) : (
        <div className={styles.fixtures}>
          {[...byFixture.entries()].map(([fixtureId, ms]) => {
            const info = getFixtureInfo(Number(fixtureId));
            return (
              <section key={fixtureId} className="card">
                <div className={styles.fixtureHead}>
                  <div>
                    <div className={styles.matchup} title={`TxLINE fixtureId ${fixtureId}`}>
                      {fixtureDisplayName(Number(fixtureId))}
                    </div>
                    <div className="muted" style={{ fontSize: "0.82rem" }}>
                      {info?.competition ?? "World Cup"} · {ms.length} market
                      {ms.length === 1 ? "" : "s"}
                    </div>
                  </div>
                  <span className="pill">devnet</span>
                </div>

                <ul className={styles.markets}>
                  {Object.values(
                    ms.reduce<Record<string, typeof ms>>((groups, m) => {
                      const key = predicateKey(m);
                      (groups[key] ??= []).push(m);
                      return groups;
                    }, {}),
                  ).map((group) => {
                    const shown = [...group].sort((a, b) => statusRank(b.status) - statusRank(a.status))[0]!;
                    const extra = group.length - 1;
                    const title = describeMarketPredicate(shown, info ?? undefined);
                    const raw = rawPredicateText(shown);
                    // Outcome is only meaningful once the oracle has actually
                    // resolved the market (Settled/Claimed) -- an
                    // Expired/Refunded market never got an outcome, so
                    // showing one there would misleadingly imply it settled.
                    const showOutcome = shown.status === STATUS_SETTLED || shown.status === STATUS_CLAIMED;
                    return (
                      <li key={shown.pda}>
                        <Link href={`/market/${shown.pda}`} className={styles.market} title={raw}>
                          <span className={styles.stat}>
                            {title}
                            {extra > 0 && (
                              <span className="muted" style={{ fontSize: "0.72rem", marginLeft: "0.4rem" }}>
                                (+{extra} more market{extra === 1 ? "" : "s"} with this same predicate)
                              </span>
                            )}
                          </span>
                          <span className={styles.pool}>
                            <span className="pill">{STATUS_NAMES[shown.status] ?? shown.status}</span>
                            {showOutcome && (
                              <span className="pill" style={{ marginLeft: "0.4rem" }}>
                                {OUTCOME_NAMES[shown.outcome] ?? shown.outcome}
                              </span>
                            )}
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
      )}

      {hiddenCount > 0 && (
        <p className="muted" style={{ marginTop: "1.5rem", fontSize: "0.78rem" }}>
          {hiddenCount} throwaway test market{hiddenCount === 1 ? "" : "s"} from
          development (fixture ids 900000000–900000999) hidden from this
          view — still real on-chain accounts, just not part of the product
          demo.
        </p>
      )}
    </>
  );
}
