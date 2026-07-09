import styles from "./mev.module.css";

const CLUSTER = "?cluster=devnet";
const tx = (sig: string) =>
  `https://explorer.solana.com/tx/${sig}${CLUSTER}`;
const addr = (a: string) =>
  `https://explorer.solana.com/address/${a}${CLUSTER}`;

const MARKET = "2VGU78vkkcYbHkdsZiowVi9R4KatY8BB1zVD32kHdHG4";

const PROOF = [
  {
    stage: "Sealed commit",
    ix: "submit_sealed_order",
    sig: "52VkeMw5eiV3xnnAPWkmSkUsLEAUa5Av7aKi94nRi7PxRWfQFQnk8n2UVcGo367phbD3Caz7Q5fnPqL9SKvsP2vn",
    check:
      "Fetch the resulting SealedOrder account: the side and size bytes read back as zero. Only the 32-byte commitment hash and locked collateral are on-chain.",
  },
  {
    stage: "Batch match",
    ix: "run_batch_match",
    sig: "JMUsrZCwhQh9TswLTqV5e8knabZmgB6G2pKa23DYVQBZdtrBgZDgMVAzKVSWRLn6S31FGJUNdE6P6CyrwXrHHGJ",
    check:
      "Market.phase flips to Matched and clearing_price is set — one uniform price for every filled order.",
  },
  {
    stage: "Settlement (oracle CPI)",
    ix: "settle_market",
    sig: "5tLRuV7XPCsRsGddA962y6Mpws1pRSeBqMH9hBBs7notEZCxUSkeWFEo1Cd9i1nb84sVms5p8ZQ7dgBdTsxXi6rF",
    check:
      "Program logs show the live CPI into TxLINE's validate_stat and its boolean return value — that alone sets the outcome.",
  },
  {
    stage: "Claim",
    ix: "claim",
    sig: "2XZr6xuPH4L15SXZcHbL27qJ2BgMNfA7eGkTrf7MeMv76imq3jSULTaeyAxg5PhU7Svdsaky4Rbj8mwxT4xtTxDm",
    check:
      "Payout computed on-chain: 1,000,000 stake in, 1,990,000 out — matches the parimutuel formula exactly.",
  },
];

// The exact fixture from the program's order-independence unit test
// (programs/onyx/src/matching.rs, matching::tests::order_independence).
const ORDERINGS = [
  "[ A₁, A₂, B₁ ]",
  "[ B₁, A₁, A₂ ]",
  "[ A₂, B₁, A₁ ]",
];

export default function MevDemoPage() {
  return (
    <>
      <h1>Why sealed-bid batching kills front-running</h1>
      <p className="muted">
        ONYX bets are committed as a hash, revealed after the window closes,
        and matched in one deterministic batch at a single uniform price.
        There is nothing to observe before the match, and nothing to gain
        from ordering — this page shows the mechanism and the real devnet
        transactions that prove it.
      </p>

      {/* ---- 1. The problem ---------------------------------------- */}
      <section className={`card ${styles.section}`} data-kind="problem">
        <div className={styles.sectionHead}>
          <h2 className={styles.h2}>1 · The problem: a visible order is an invitation</h2>
          <span className="pill" style={{ borderColor: "var(--amber)", color: "var(--amber)" }}>
            illustration — not live data
          </span>
        </div>
        <p className={`muted ${styles.blurb}`}>
          On a public book, a pending order sits in plain sight before it
          executes. A searcher who sees a large order can buy in front of it
          and sell right after — the classic sandwich. The victim pays the
          spread the attacker created.
        </p>
        <ul className={styles.book}>
          <li data-role="attack">
            <span className="mono">searcher</span>
            <span className={styles.yes}>BUY</span>
            <span className="mono">front-run</span>
          </li>
          <li data-role="victim">
            <span className="mono">0xc3 · pending</span>
            <span className={styles.yes}>YES</span>
            <span className="mono">900 — visible to everyone</span>
          </li>
          <li data-role="attack">
            <span className="mono">searcher</span>
            <span className={styles.no}>SELL</span>
            <span className="mono">back-run</span>
          </li>
        </ul>
        <div className={styles.attack}>
          The attack needs exactly two things: seeing the order before it
          executes, and being able to get in line around it. Remove either
          and the sandwich is dead.
        </div>
      </section>

      {/* ---- 2. How ONYX does it ------------------------------------ */}
      <section className={`card ${styles.section}`} data-kind="fix">
        <div className={styles.sectionHead}>
          <h2 className={styles.h2}>2 · How ONYX removes both — on L1, no new trust</h2>
          <span className="pill" style={{ borderColor: "var(--green)", color: "var(--green)" }}>
            shipped · devnet
          </span>
        </div>
        <ol className={styles.steps}>
          <li>
            <span className="mono">open_market_sealed</span>
            <p className="muted">
              Market opens in a commit phase with fixed commit and reveal
              windows.
            </p>
          </li>
          <li>
            <span className="mono">submit_sealed_order</span>
            <p className="muted">
              Only a 32-byte keccak-256 commitment plus locked collateral
              lands on-chain. Side, size, and limit price are not derivable
              from any on-chain state. <em>Nothing to see.</em>
            </p>
          </li>
          <li>
            <span className="mono">reveal_order</span>
            <p className="muted">
              After the commit window closes, each bettor reveals; the
              program recomputes the hash and rejects any mismatch.
            </p>
          </li>
          <li>
            <span className="mono">run_batch_match</span>
            <p className="muted">
              Permissionless. All revealed orders clear in one pass at a
              single uniform price. <em>Nothing to get in line around.</em>
            </p>
          </li>
        </ol>

        <div className={styles.determinism}>
          <h3 className={styles.h3}>Order-independent by construction</h3>
          <p className={`muted ${styles.blurb}`}>
            Take the same three revealed orders — A₁ buys 100 @ 70, A₂ buys
            200 @ 60, B₁ sells 90 @ 50 — and feed them to the matcher in any
            order. The program&apos;s own unit test
            (<span className="mono">matching::tests::order_independence</span>)
            asserts the result is bit-exact identical:
          </p>
          <div className={styles.orderings}>
            {ORDERINGS.map((o) => (
              <div key={o} className={styles.ordering}>
                <span className="mono">{o}</span>
                <span className={styles.arrow}>→</span>
                <span className="mono">clears at 50 · fills 30 / 60 / 90</span>
              </div>
            ))}
          </div>
          <p className={`muted ${styles.blurb}`} style={{ marginBottom: 0 }}>
            Same price, same fills, every permutation. When submission order
            cannot change your outcome, being first — the entire business
            model of front-running and copy-trading — is worth nothing.
          </p>
        </div>
      </section>

      {/* ---- 3. Proof ----------------------------------------------- */}
      <section className={`card ${styles.section}`} data-kind="proof">
        <div className={styles.sectionHead}>
          <h2 className={styles.h2}>3 · Proven on devnet, not claimed</h2>
          <span className="pill">public RPC · verify without trusting this UI</span>
        </div>
        <p className={`muted ${styles.blurb}`}>
          One full sealed-order lifecycle on market{" "}
          <a href={addr(MARKET)} className="mono" target="_blank" rel="noreferrer">
            {MARKET.slice(0, 8)}…{MARKET.slice(-6)}
          </a>
          . Every signature is real; open it on the explorer or run{" "}
          <span className="mono">solana confirm -v &lt;sig&gt; --url devnet</span> —
          none of it needs this UI to be trusted.
        </p>
        <ul className={styles.proof}>
          {PROOF.map((p) => (
            <li key={p.sig}>
              <div className={styles.proofHead}>
                <strong>{p.stage}</strong>
                <span className="pill mono">{p.ix}</span>
              </div>
              <a href={tx(p.sig)} className="mono" target="_blank" rel="noreferrer">
                {p.sig.slice(0, 20)}…{p.sig.slice(-10)} ↗
              </a>
              <p className="muted">{p.check}</p>
            </li>
          ))}
        </ul>
      </section>

      {/* ---- 4. Honest roadmap note --------------------------------- */}
      <section className={`card ${styles.section}`} data-kind="roadmap">
        <div className={styles.sectionHead}>
          <h2 className={styles.h2}>4 · What about TEEs? Roadmap, not shipped</h2>
          <span className="pill">de-risk spike · held back</span>
        </div>
        <p className={`muted ${styles.blurb}`} style={{ marginBottom: 0 }}>
          A MagicBlock ephemeral-rollup / TEE execution path (sealed orders
          matched inside an attested enclave, ~10ms latency) was proven
          end-to-end as a de-risk spike — including a live DCAP-verified
          attestation — and then deliberately <em>not</em> built into this
          product. Everything above runs on plain Solana L1 devnet, because
          moving matching into a TEE would reintroduce a hardware and
          operator trust dependency this design exists to avoid. The spike
          is logged in <span className="mono">BUILD_STATE.md</span>; it is
          roadmap material, not part of what you just verified.
        </p>
      </section>
    </>
  );
}
