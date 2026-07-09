import Link from "next/link";
import { listMarkets, STATUS_NAMES, OUTCOME_NAMES, CMP_SYMBOLS } from "@/lib/onchain";
import styles from "./lobby.module.css";

export const dynamic = "force-dynamic"; // always read live devnet state, never cache

export default async function LobbyPage() {
  const markets = await listMarkets();

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
          {[...byFixture.entries()].map(([fixtureId, ms]) => (
            <section key={fixtureId} className="card">
              <div className={styles.fixtureHead}>
                <div>
                  <div className={styles.matchup}>
                    Fixture #{fixtureId}
                  </div>
                  <div className="muted" style={{ fontSize: "0.82rem" }}>
                    TxLINE fixtureId {fixtureId} · {ms.length} market
                    {ms.length === 1 ? "" : "s"}
                  </div>
                </div>
                <span className="pill">devnet</span>
              </div>

              <ul className={styles.markets}>
                {ms.map((m) => (
                  <li key={m.pda}>
                    <Link href={`/market/${m.pda}`} className={styles.market}>
                      <span className={styles.stat}>
                        stat[{m.statAKey}] {CMP_SYMBOLS[m.predicate] ?? "?"}{" "}
                        {m.threshold.toString()}
                      </span>
                      <span className={styles.pool}>
                        <span className="pill">{STATUS_NAMES[m.status] ?? m.status}</span>
                        {m.status >= 4 && (
                          <span className="pill" style={{ marginLeft: "0.4rem" }}>
                            {OUTCOME_NAMES[m.outcome] ?? m.outcome}
                          </span>
                        )}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </>
  );
}
