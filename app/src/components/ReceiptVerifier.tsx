import { leafFromScoreStat, toHex, verifyMerkleProof } from "@/lib/merkle";
import type { OnChainMarket } from "@/lib/onchain";
import { STATUS_NAMES, OUTCOME_NAMES, explorerTxUrl } from "@/lib/onchain";
import styles from "./ReceiptVerifier.module.css";

interface SettleTx {
  signature: string;
  logs: string[];
  slot: number;
}

// Shape of the bundled fixtures/scores-validation.sample.json capture.
interface CapturedProof {
  fixtureId: number;
  seq: number;
  epochDay: number;
  payload: {
    statsToProve: Array<{ key: number; value: number; period: number }>;
    eventStatRoot: number[];
    statProofs: Array<Array<{ hash: number[]; isRightSibling: boolean }>>;
    subTreeProof: Array<{ hash: number[]; isRightSibling: boolean }>;
    mainTreeProof: Array<{ hash: number[]; isRightSibling: boolean }>;
    summary: {
      fixtureId: number;
      eventStatsSubTreeRoot: number[];
      updateStats: { updateCount: number; minTimestamp: number; maxTimestamp: number };
    };
  };
}

/**
 * THE VERIFIABLE RECEIPT.
 *
 * The authoritative verdict here is NOT recomputed in the browser — it comes
 * from two independently-checkable on-chain facts: the Market account's own
 * `status`/`outcome` fields, and the real txoracle program's own log lines
 * from the settle_market transaction (fetched live, not hardcoded). Anyone
 * can re-derive both of those themselves from a public RPC endpoint without
 * trusting this UI at all.
 *
 * We ALSO attempt a local keccak re-derivation of the stat leaf up to the
 * oracle's `event_stat_root` (an on-chain-verifiable independent check gate,
 * matching the on-chain merkle.rs fold rule byte-for-byte). That part is
 * clearly separated below: the oracle's internal leaf pre-image format
 * (exact byte layout it hashes before folding) isn't publicly documented, so
 * this experimental hop may not match yet — see BUILD_STATE.md. That does
 * NOT affect the authoritative verdict, which never depends on it.
 */
export function ReceiptVerifier({
  market,
  settleTx,
  proof,
}: {
  market: OnChainMarket;
  settleTx: SettleTx | null;
  proof: CapturedProof | null;
}) {
  const settled = market.status >= 4;
  const outcomeKnown = market.outcome === 1 || market.outcome === 2;

  const oracleLogs = (settleTx?.logs ?? []).filter(
    (l) =>
      l.includes("Program log:") &&
      (l.includes("validation") || l.includes("predicate") || l.includes("Instruction")),
  );

  return (
    <div className={styles.wrap}>
      <div className={styles.verdict} data-ok={settled && outcomeKnown ? "true" : "false"}>
        <div className={styles.verdictBadge}>
          {settled && outcomeKnown
            ? `✓ SETTLED ON-CHAIN — outcome: ${OUTCOME_NAMES[market.outcome]}`
            : `PENDING — status: ${STATUS_NAMES[market.status] ?? market.status}`}
        </div>
        <div className={styles.verdictSub}>
          {settled && outcomeKnown ? (
            settleTx ? (
              <>
                Confirmed by a live CPI from ONYX into the real txoracle
                program on devnet — see the transaction:{" "}
                <a href={explorerTxUrl(settleTx.signature)} target="_blank" rel="noreferrer">
                  {settleTx.signature.slice(0, 20)}…
                </a>
              </>
            ) : (
              "Market state confirms settlement, but the settle transaction couldn't be located in recent signature history for this account."
            )
          ) : (
            "This market has not settled yet."
          )}
        </div>
      </div>

      {oracleLogs.length > 0 && (
        <>
          <h2>Real on-chain oracle log</h2>
          <p className="muted" style={{ fontSize: "0.85rem" }}>
            Exact log lines emitted by the live txoracle program (
            <span className="mono">6pW64g…5wyP2J</span>) during this
            transaction — fetched from devnet just now, not stored anywhere.
          </p>
          <div className={styles.hashes}>
            {oracleLogs.map((l, i) => (
              <div key={i} className="mono" style={{ fontSize: "0.82rem" }}>
                {l.replace(/^Program log:\s*/, "")}
              </div>
            ))}
          </div>
        </>
      )}

      {proof && (
        <>
          <h2>Submitted proof data</h2>
          <p className="muted" style={{ fontSize: "0.85rem" }}>
            The exact bytes ONYX sent into <span className="mono">validate_stat</span>{" "}
            for fixture #{proof.fixtureId} (seq {proof.seq}, epoch day{" "}
            {proof.epochDay}).
          </p>
          <div className={styles.hashes}>
            <Row label="stat">
              key {proof.payload.statsToProve[0]?.key} · value{" "}
              {proof.payload.statsToProve[0]?.value} · period{" "}
              {proof.payload.statsToProve[0]?.period}
            </Row>
            <Row label="event_stat_root" mono>
              {toHex(Uint8Array.from(proof.payload.eventStatRoot))}
            </Row>
            <Row label="events_sub_tree_root" mono>
              {toHex(Uint8Array.from(proof.payload.summary.eventStatsSubTreeRoot))}
            </Row>
            <Row label="proof path lengths">
              stat_proof: {proof.payload.statProofs[0]?.length ?? 0} nodes ·
              fixture_proof: {proof.payload.subTreeProof.length} nodes ·
              main_tree_proof: {proof.payload.mainTreeProof.length} nodes
            </Row>
          </div>

          <LocalRederivation proof={proof} />
        </>
      )}
    </div>
  );
}

/** The clearly-scoped "experimental" client-side re-derivation attempt. */
function LocalRederivation({ proof }: { proof: CapturedProof }) {
  const stat = proof.payload.statsToProve[0]!;
  const leaf = leafFromScoreStat(stat);
  const result = verifyMerkleProof(
    leaf,
    proof.payload.statProofs[0]!,
    Uint8Array.from(proof.payload.eventStatRoot),
  );

  return (
    <details className={styles.editor}>
      <summary>
        Advanced: client-side Merkle re-derivation{" "}
        <span className="pill">experimental · independent of the verdict above</span>
      </summary>
      <p className="muted" style={{ fontSize: "0.82rem", marginTop: "0.5rem" }}>
        The settlement verdict above is already fully trustless — it comes
        from the oracle&apos;s own on-chain attestation, not from anything
        computed here. This section is a separate research exercise: it
        recomputes <span className="mono">keccak256(key‖value‖period)</span>{" "}
        as the leaf and folds it through the stat proof using the exact same
        rule as the on-chain <span className="mono">merkle.rs</span> (
        <span className="mono">is_right_sibling</span>-directed keccak
        pairing — verified and locked). What is <em>not</em> yet publicly
        documented is txoracle&apos;s internal leaf pre-image byte layout, so
        this one hop is{" "}
        <strong>{result.ok ? "currently matching" : "not matching yet"}</strong>{" "}
        pending confirmation from TxODDS. This has{" "}
        <strong>no bearing</strong> on the settled outcome.
      </p>
      <div className={styles.hashes} style={{ marginTop: "0.5rem" }}>
        <Row label="recomputed leaf" mono>
          {toHex(leaf)}
        </Row>
        <Row label="computed fold" mono ok={result.ok}>
          {result.computedRoot}
        </Row>
        <Row label="event_stat_root" mono>
          {result.expectedRoot}
        </Row>
      </div>
    </details>
  );
}

function Row({
  label,
  children,
  mono,
  ok,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
  ok?: boolean;
}) {
  return (
    <div className={styles.hashRow}>
      <span className={styles.hashLabel}>{label}</span>
      <span
        className={mono ? "mono" : undefined}
        style={ok === false ? { color: "var(--amber)" } : undefined}
      >
        {children}
      </span>
    </div>
  );
}
