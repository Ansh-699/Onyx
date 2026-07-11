"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Transaction } from "@solana/web3.js";
import type { Comparison } from "@/lib/types";
import { comparisonSymbol } from "@/lib/merkle";
import { getConfigUsdcMint, explorerTxUrl, explorerAddressUrl } from "@/lib/onchain";
import { SELECTABLE_STAT_OPTIONS, pairedStatKey, OP_ADD, OP_SUBTRACT } from "@/lib/statKeys";
import { listUpcomingRealFixtures } from "@/lib/fixtureMeta";
import { useLiveFixtures } from "@/lib/hooks";
import { friendlyError } from "@/lib/errors";
import {
  buildOpenMarketSealedIx,
  buildOpenMarketIx,
  buildCreateAmmPoolIx,
  computeParamsHash,
  CMP_GREATER_THAN,
  CMP_LESS_THAN,
  CMP_EQUAL_TO,
  OP_NONE,
} from "@/lib/instructions";
import { WalletButton } from "@/components/WalletButton";
import styles from "./create.module.css";

// This fixture has a real BUNDLED oracle proof (fixtures/scores-validation.
// sample.json) as a fallback settlement path with zero TxLINE-live-API
// dependency — but it is no longer the only settleable fixture.
// SettleClaimPanel now fetches a LIVE proof from TxLINE's own
// /scores/stat-validation for any market's actual on-chain fixtureId/stat
// terms (see /api/settlement-proof + txlineSettlementProof.ts), verified
// live against several other real fixtures the sandbox has data for. This
// demo fixture's statKey stays pinned to 1 to match the bundled fallback
// capture specifically, not because it's the only stat that can ever settle.
const DEMO_FIXTURE = {
  fixtureId: 18179550,
  label: "World Cup demo fixture (bundled fallback proof — always settles, even offline)",
  statKey: 1,
  defaultThreshold: 2,
};

// Static fallback for the fixture picker — replaced by the live
// /api/fixtures window (useLiveFixtures) as soon as it loads.
const STATIC_UPCOMING = listUpcomingRealFixtures().map((f) => ({
  fixtureId: f.fixtureId,
  participant1: f.info.participant1,
  participant2: f.info.participant2,
  competition: f.info.competition,
  startTimeMs: f.startTimeMs,
}));

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

  const [marketType, setMarketType] = useState<"sealed" | "amm">("sealed");
  const [fixtureId, setFixtureId] = useState<number>(DEMO_FIXTURE.fixtureId);
  const [statKey, setStatKey] = useState<number>(DEMO_FIXTURE.statKey);
  const [combined, setCombined] = useState(false);
  const [combineOp, setCombineOp] = useState<"add" | "subtract">("add");
  const [op, setOp] = useState<Comparison>("greaterThan");
  const [threshold, setThreshold] = useState<string>(String(DEMO_FIXTURE.defaultThreshold));
  const [commitMinutes, setCommitMinutes] = useState<string>("3");
  const [revealMinutes, setRevealMinutes] = useState<string>("3");
  // AMM-only: your real tUSDC seeds the pool at 50/50; you are the LP.
  const [seedUsdc, setSeedUsdc] = useState<string>("2");
  const [feePct, setFeePct] = useState<string>("1.0");
  const [tradingHours, setTradingHours] = useState<string>("24");

  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ signature: string; market: string } | null>(null);

  // Live TxLINE fixture window (real team names + kickoff times); upcoming
  // only — a market on an already-finished fixture would settle instantly.
  const liveFixtures = useLiveFixtures();
  const upcomingFixtures = (
    liveFixtures.data?.filter((f) => f.fixtureId !== DEMO_FIXTURE.fixtureId && (f.startTimeMs === null || f.startTimeMs > Date.now())) ??
    STATIC_UPCOMING
  );

  const isDemoFixture = fixtureId === DEMO_FIXTURE.fixtureId;
  const statOptions = isDemoFixture ? [{ label: "P1 goals", key: DEMO_FIXTURE.statKey }] : SELECTABLE_STAT_OPTIONS;
  const statLabel = statOptions.find((s) => s.key === statKey)?.label ?? "stat";
  // Combined ADD/SUBTRACT-over-two-stats markets ("Total corners", "Goal
  // difference") -- the on-chain program and describeMarketPredicate already
  // support this (op field + a second stat key), only /create's form never
  // exposed it. Disabled for the demo fixture: SettleClaimPanel's `provable`
  // gate requires statBKey===0 && op===OP_NONE, since the bundled proof only
  // covers a single stat -- a combined demo-fixture market would create
  // orders normally but never be settleable from this UI.
  const pairKey = !isDemoFixture ? pairedStatKey(statKey) : null;
  const pairLabel = pairKey != null ? SELECTABLE_STAT_OPTIONS.find((s) => s.key === pairKey)?.label : null;
  const isCombined = combined && pairKey != null;

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
      // Sealed: deadline follows the reveal window. AMM: continuous trading
      // until the creator-chosen close — no windows at all.
      const deadline =
        marketType === "sealed"
          ? revealEndTs + 900n
          : nowSec + BigInt(Math.max(1, Math.round(Number(tradingHours || "24") * 3600)));

      const terms = {
        fixtureId: BigInt(fixtureId),
        statAKey: statKey,
        statBKey: isCombined ? pairKey! : 0,
        op: isCombined ? (combineOp === "add" ? OP_ADD : OP_SUBTRACT) : OP_NONE,
        predicate: CMP_MAP[op],
        threshold: BigInt(threshold || "0"),
        deadline,
      };
      const paramsHash = computeParamsHash(terms);

      const tx = new Transaction();
      let market;
      if (marketType === "sealed") {
        const built = buildOpenMarketSealedIx({
          creator: publicKey,
          usdcMint,
          terms,
          paramsHash,
          commitEndTs,
          revealEndTs,
        });
        market = built.market;
        tx.add(built.ix);
      } else {
        // AMM: the creator seeds the pool with REAL tUSDC from their own
        // ATA (they become the LP, capital genuinely at risk). Fetch from
        // the devnet faucet first so a fresh wallet can seed.
        const seedAmount = BigInt(Math.round(Number(seedUsdc || "0") * 1_000_000));
        if (seedAmount <= 0n) throw new Error("seed amount must be > 0");
        const feeBps = Math.round(Number(feePct || "0") * 100);
        if (feeBps < 0 || feeBps > 1000) throw new Error("fee must be between 0% and 10%");

        const faucetRes = await fetch("/api/faucet", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user: publicKey.toBase58() }),
        });
        const faucetBody = await faucetRes.json();
        if (!faucetRes.ok || !faucetBody.ok) throw new Error(`devnet faucet failed: ${faucetBody.error ?? faucetRes.status}`);

        const opened = buildOpenMarketIx({ creator: publicKey, usdcMint, terms, paramsHash });
        market = opened.market;
        const pooled = buildCreateAmmPoolIx({ creator: publicKey, market, usdcMint, seedAmount, feeBps });
        tx.add(opened.ix, pooled.ix);
      }

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;

      const signature = await sendTransaction(tx, connection);
      await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");

      setResult({ signature, market: market.toBase58() });
      setPhase("done");
    } catch (err) {
      setError(friendlyError(err));
      setPhase("error");
    }
  }

  return (
    <>
      <h1>Create market</h1>
      <p className="muted">
        {marketType === "sealed" ? (
          <>
            Define a predicate over a fixture stat and open a{" "}
            <strong>sealed-order market</strong>: bets are hidden (commitment hash
            only) until the commit window closes, then revealed and matched at a
            single uniform price with no time-priority advantage. This submits a
            real <code>open_market_sealed</code> transaction to devnet.
          </>
        ) : (
          <>
            Define a predicate over a fixture stat and open an{" "}
            <strong>AMM market</strong>: continuous Polymarket-style trading — the
            pool is the counterparty, so anyone can buy <em>and sell</em> outcome
            tokens at any moment before the close. You seed the pool with your own
            real test-USDC and become its LP. This submits <code>open_market</code>{" "}
            + <code>create_amm_pool</code> in one devnet transaction.
          </>
        )}
      </p>

      {!connected && (
        <div className="card" style={{ marginTop: "1rem" }}>
          <p className="muted" style={{ marginTop: 0 }}>
            Connect a devnet wallet to create a market.
          </p>
          <WalletButton />
        </div>
      )}

      <div className={`card ${styles.formCard}`}>
      <form className={styles.form} onSubmit={onSubmit}>
        <label className={styles.field}>
          <span>Market type</span>
          <select value={marketType} onChange={(e) => setMarketType(e.target.value as "sealed" | "amm")} data-testid="create-market-type">
            <option value="sealed">Sealed batch — MEV-proof commit/reveal, uniform clearing price</option>
            <option value="amm">AMM — continuous trading, sell anytime, real seeded liquidity</option>
          </select>
        </label>

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
            {upcomingFixtures.map((f) => (
              <option key={f.fixtureId} value={f.fixtureId}>
                {f.participant1} vs {f.participant2} · {f.competition}
                {f.startTimeMs ? ` · ${new Date(f.startTimeMs).toLocaleDateString()}` : ""} (#{f.fixtureId})
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

        {pairKey != null && (
          <div className={styles.row}>
            <label className={styles.field} style={{ flexDirection: "row", alignItems: "center", gap: "0.5rem" }}>
              <input type="checkbox" checked={combined} onChange={(e) => setCombined(e.target.checked)} />
              <span>Combine with {pairLabel} (both participants)</span>
            </label>
            {combined && (
              <label className={styles.field}>
                <span>Combine as</span>
                <select value={combineOp} onChange={(e) => setCombineOp(e.target.value as "add" | "subtract")}>
                  <option value="add">Total (add)</option>
                  <option value="subtract">Difference (subtract)</option>
                </select>
              </label>
            )}
          </div>
        )}

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

        {marketType === "sealed" ? (
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
        ) : (
          <div className={styles.row}>
            <label className={styles.field}>
              <span>Pool seed (test-USDC — your capital, you are the LP)</span>
              <input type="number" min={0.1} step="0.1" value={seedUsdc} onChange={(e) => setSeedUsdc(e.target.value)} data-testid="create-seed" />
            </label>
            <label className={styles.field}>
              <span>Swap fee (%) — accrues to you</span>
              <input type="number" min={0} max={10} step="0.1" value={feePct} onChange={(e) => setFeePct(e.target.value)} />
            </label>
            <label className={styles.field}>
              <span>Trading open for (hours)</span>
              <input type="number" min={1} value={tradingHours} onChange={(e) => setTradingHours(e.target.value)} />
            </label>
          </div>
        )}

        <div className={styles.preview}>
          Settles YES iff{" "}
          <strong>
            {isCombined ? `${combineOp === "add" ? "total" : "difference in"} ${statLabel.replace(/^P\d /, "")} (${statLabel} ${combineOp === "add" ? "+" : "−"} ${pairLabel})` : statLabel}{" "}
            {comparisonSymbol(op)} {threshold || "?"}
          </strong>
          .{" "}
          {marketType === "sealed" ? (
            <>
              Orders are sealed for {commitMinutes || "?"} min, then revealed for {revealMinutes || "?"} min before
              the batch match runs.
            </>
          ) : (
            <>
              Pool opens at 50/50 with your {seedUsdc || "?"} tUSDC seed ({feePct || "?"}% fee per swap to you);
              anyone can buy and sell continuously for {tradingHours || "?"}h.{" "}
              <strong>LP risk is real:</strong> if traders load the side that wins, the reserve you withdraw after
              settlement can be worth less than your seed. AMM markets are not MEV-proof (that&apos;s what sealed
              markets are for).
            </>
          )}
          {isDemoFixture ? (
            <>
              {" "}
              This fixture also has a real proof BUNDLED in this build, so{" "}
              <code>settle_market</code> can resolve this market even if
              TxLINE&apos;s live API is unreachable at settlement time.
            </>
          ) : (
            <>
              {" "}
              <code>settle_market</code> fetches a live proof from
              TxLINE&apos;s own <code>validate_stat</code> data for this
              fixture at settlement time — real oracle CPI, not simulated.
            </>
          )}
        </div>

        <button className="button" type="submit" disabled={!connected || phase === "submitting"} data-testid="create-submit">
          {phase === "submitting" ? "Submitting…" : marketType === "sealed" ? "Create sealed market" : "Create AMM market & seed pool"}
        </button>
      </form>
      </div>

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
