"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Transaction } from "@solana/web3.js";
import type { Comparison } from "@/lib/types";
import { comparisonSymbol } from "@/lib/merkle";
import { getConfigUsdcMint, explorerTxUrl, explorerAddressUrl } from "@/lib/onchain";
import { SELECTABLE_STAT_OPTIONS } from "@/lib/statKeys";
import { listUpcomingRealFixtures } from "@/lib/fixtureMeta";
import {
  buildOpenMarketSealedIx,
  computeParamsHash,
  CMP_GREATER_THAN,
  CMP_LESS_THAN,
  CMP_EQUAL_TO,
  OP_NONE,
} from "@/lib/instructions";
import { WalletButton } from "@/components/WalletButton";
import styles from "./create.module.css";

// The one fixture with a REAL captured oracle proof bundled in this repo
// (fixtures/scores-validation.sample.json) — the only fixture id a market
// created here can actually be settled against via a real validate_stat CPI.
// statKey MUST be 1 (the captured proof's actual `statsToProve[0].key`, NOT
// any of the illustrative STAT_KEYS.* mock values) — settle_market's own CPI
// args are built straight from the captured fixture's real key
// (instructions.ts::buildSettleMarketIx), and the program does NOT
// cross-check market.statAKey against them. Using the wrong key here
// wouldn't fail on-chain; it would silently settle correctly while
// *displaying* a stat key that has nothing to do with what was actually
// verified — exactly the kind of inconsistency this project's whole pitch
// argues against. stat.value=3 in the capture, so threshold=2 with ">" is
// what makes settle_market resolve deterministically (matches the
// already-proven devnet L0 run).
const DEMO_FIXTURE = {
  fixtureId: 18179550,
  label: "World Cup demo fixture (real oracle proof — settles live)",
  statKey: 1,
  defaultThreshold: 2,
};

// Real, currently-upcoming World Cup fixtures (verified live via TxLINE
// /fixtures/snapshot, competitionId=72) -- not settleable yet (no proof
// exists until they kick off and finish), but real fixtures with real team
// names, same as the ones already seeded into the lobby.
const REAL_UPCOMING_FIXTURES = listUpcomingRealFixtures();

const CMP_MAP: Record<Comparison, number> = {
  greaterThan: CMP_GREATER_THAN,
  lessThan: CMP_LESS_THAN,
  equalTo: CMP_EQUAL_TO,
};
const OPS: { value: Comparison; label: string }[] = [
  { value: "greaterThan", label: "Greater than (>)" },
  { value: "lessThan", label: "Less than (<)" },
  { value: "equalTo", label: "Equal to (=)" },
];

type Phase = "idle" | "submitting" | "done" | "error";

export default function CreatePage() {
  const router = useRouter();
  const { connection } = useConnection();
  const { publicKey, sendTransaction, connected } = useWallet();

  const [fixtureId, setFixtureId] = useState<number>(DEMO_FIXTURE.fixtureId);
  const [statKey, setStatKey] = useState<number>(DEMO_FIXTURE.statKey);
  const [op, setOp] = useState<Comparison>("greaterThan");
  const [threshold, setThreshold] = useState<string>(String(DEMO_FIXTURE.defaultThreshold));
  const [commitMinutes, setCommitMinutes] = useState<string>("3");
  const [revealMinutes, setRevealMinutes] = useState<string>("3");

  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ signature: string; market: string } | null>(null);

  const isDemoFixture = fixtureId === DEMO_FIXTURE.fixtureId;
  const statOptions = isDemoFixture ? [{ label: "P1 goals", key: DEMO_FIXTURE.statKey }] : SELECTABLE_STAT_OPTIONS;
  const statLabel = statOptions.find((s) => s.key === statKey)?.label ?? "stat";

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!publicKey) {
      setError("Connect a devnet wallet first.");
      return;
    }
    setPhase("submitting");
    try {
      const usdcMint = await getConfigUsdcMint();
      if (!usdcMint) {
        throw new Error(
          "ONYX config isn't initialized on devnet yet — run services/ingestion/src/l0_loop_test.ts once to bootstrap it.",
        );
      }

      const nowSec = BigInt(Math.floor(Date.now() / 1000));
      const commitEndTs = nowSec + BigInt(Math.max(1, Number(commitMinutes))) * 60n;
      const revealEndTs = commitEndTs + BigInt(Math.max(1, Number(revealMinutes))) * 60n;
      const deadline = revealEndTs + 900n; // 15 min of live-betting room after matching, before deadline

      const terms = {
        fixtureId: BigInt(fixtureId),
        statAKey: statKey,
        statBKey: 0,
        op: OP_NONE,
        predicate: CMP_MAP[op],
        threshold: BigInt(threshold || "0"),
        deadline,
      };
      const paramsHash = computeParamsHash(terms);

      const { ix, market } = buildOpenMarketSealedIx({
        creator: publicKey,
        usdcMint,
        terms,
        paramsHash,
        commitEndTs,
        revealEndTs,
      });

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      const tx = new Transaction();
      tx.add(ix);
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;

      const signature = await sendTransaction(tx, connection);
      await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");

      setResult({ signature, market: market.toBase58() });
      setPhase("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }

  return (
    <>
      <h1>Create market</h1>
      <p className="muted">
        Define a predicate over a fixture stat and open a{" "}
        <strong>sealed-order market</strong>: bets are hidden (commitment hash
        only) until the commit window closes, then revealed and matched at a
        single uniform price with no time-priority advantage. This submits a
        real <code>open_market_sealed</code> transaction to devnet.
      </p>

      {!connected && (
        <div className="card" style={{ marginTop: "1rem" }}>
          <p className="muted" style={{ marginTop: 0 }}>
            Connect a devnet wallet to create a market.
          </p>
          <WalletButton />
        </div>
      )}

      <form className={styles.form} onSubmit={onSubmit}>
        <label className={styles.field}>
          <span>Fixture</span>
          <select
            value={fixtureId}
            onChange={(e) => {
              const id = Number(e.target.value);
              setFixtureId(id);
              if (id === DEMO_FIXTURE.fixtureId) {
                setStatKey(DEMO_FIXTURE.statKey);
                setThreshold(String(DEMO_FIXTURE.defaultThreshold));
                setOp("greaterThan");
              }
            }}
          >
            <option value={DEMO_FIXTURE.fixtureId}>{DEMO_FIXTURE.label}</option>
            {REAL_UPCOMING_FIXTURES.map((f) => (
              <option key={f.fixtureId} value={f.fixtureId}>
                {f.info.participant1} vs {f.info.participant2} (#{f.fixtureId}) — real fixture, not started yet, no settlement until it finishes
              </option>
            ))}
          </select>
        </label>

        <label className={styles.field}>
          <span>Stat</span>
          <select value={statKey} onChange={(e) => setStatKey(Number(e.target.value))} disabled={isDemoFixture}>
            {statOptions.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label} (key {s.key})
              </option>
            ))}
          </select>
        </label>

        <div className={styles.row}>
          <label className={styles.field}>
            <span>Operator</span>
            <select value={op} onChange={(e) => setOp(e.target.value as Comparison)}>
              {OPS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>

          <label className={styles.field}>
            <span>Threshold</span>
            <input type="number" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
          </label>
        </div>

        <div className={styles.row}>
          <label className={styles.field}>
            <span>Commit window (minutes)</span>
            <input type="number" min={1} value={commitMinutes} onChange={(e) => setCommitMinutes(e.target.value)} />
          </label>
          <label className={styles.field}>
            <span>Reveal window (minutes)</span>
            <input type="number" min={1} value={revealMinutes} onChange={(e) => setRevealMinutes(e.target.value)} />
          </label>
        </div>

        <div className={styles.preview}>
          Settles YES iff{" "}
          <strong>
            {statLabel} {comparisonSymbol(op)} {threshold || "?"}
          </strong>
          . Orders are sealed for {commitMinutes || "?"} min, then revealed
          for {revealMinutes || "?"} min before the batch match runs.
          {isDemoFixture && (
            <>
              {" "}
              This fixture has a real captured oracle proof (value=3), so{" "}
              <code>settle_market</code> will genuinely resolve this market
              via a live <code>validate_stat</code> CPI.
            </>
          )}
        </div>

        <button className="button" type="submit" disabled={!connected || phase === "submitting"}>
          {phase === "submitting" ? "Submitting…" : "Create market"}
        </button>
      </form>

      {error && (
        <div className="card" style={{ marginTop: "1.5rem", borderColor: "var(--danger, #b33)" }}>
          <div className="muted" style={{ fontSize: "0.8rem" }}>
            Failed
          </div>
          <pre className="mono" style={{ whiteSpace: "pre-wrap", margin: 0 }}>
            {error}
          </pre>
        </div>
      )}

      {result && (
        <div className="card" style={{ marginTop: "1.5rem" }}>
          <div className="muted" style={{ fontSize: "0.8rem" }}>
            Market created on devnet
          </div>
          <p className="mono" style={{ margin: "0.5rem 0" }}>
            {result.market}
          </p>
          <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
            <a href={explorerTxUrl(result.signature)} target="_blank" rel="noreferrer">
              View transaction ↗
            </a>
            <a href={explorerAddressUrl(result.market)} target="_blank" rel="noreferrer">
              View market account ↗
            </a>
            <button className="button" type="button" onClick={() => router.push(`/market/${result.market}`)}>
              Open market →
            </button>
          </div>
        </div>
      )}
    </>
  );
}
