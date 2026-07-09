import styles from "./mev.module.css";

interface OrderRow {
  id: string;
  side: "YES" | "NO";
  size: number;
  visible: boolean;
}

const PUBLIC_ORDERS: OrderRow[] = [
  { id: "0xa1", side: "YES", size: 500, visible: true },
  { id: "0xb2", side: "NO", size: 320, visible: true },
  { id: "0xc3", side: "YES", size: 900, visible: true },
];

const SHIELDED_ORDERS: OrderRow[] = [
  { id: "•••", side: "YES", size: 0, visible: false },
  { id: "•••", side: "NO", size: 0, visible: false },
  { id: "•••", side: "YES", size: 0, visible: false },
];

export default function MevDemoPage() {
  return (
    <>
      <h1>MEV: public mempool vs shielded matching</h1>
      <p className="muted">
        Side-by-side of a naive public order book (front-runnable) against
        ONYX&apos;s TEE-sealed sealed-bid batch on MagicBlock PER. In the
        shielded lane, side + size stay encrypted until the batch clears, so
        there is nothing to front-run.
      </p>

      <div className={styles.split}>
        <section className={`card ${styles.lane}`} data-kind="public">
          <div className={styles.laneHead}>
            <h2 style={{ margin: 0 }}>Public book</h2>
            <span className="pill" style={{ borderColor: "var(--red)", color: "var(--red)" }}>
              front-runnable
            </span>
          </div>
          <p className="muted" style={{ fontSize: "0.85rem" }}>
            Pending orders visible in the mempool. A searcher can observe the
            900-unit YES order and sandwich it.
          </p>
          <ul className={styles.orders}>
            {PUBLIC_ORDERS.map((o) => (
              <li key={o.id}>
                <span className="mono">{o.id}</span>
                <span className={o.side === "YES" ? styles.yes : styles.no}>
                  {o.side}
                </span>
                <span className="mono">{o.size}</span>
              </li>
            ))}
          </ul>
          <div className={styles.attack}>
            ⚠ searcher inserts front-run + back-run around the large order
          </div>
        </section>

        <section className={`card ${styles.lane}`} data-kind="shielded">
          <div className={styles.laneHead}>
            <h2 style={{ margin: 0 }}>Shielded batch (TEE)</h2>
            <span
              className="pill"
              style={{ borderColor: "var(--green)", color: "var(--green)" }}
            >
              MEV-proof
            </span>
          </div>
          <p className="muted" style={{ fontSize: "0.85rem" }}>
            Sealed bids on <span className="mono">devnet-tee-as.magicblock.app</span>.
            Side + size encrypted until the batch clears at a uniform price.
          </p>
          <ul className={styles.orders}>
            {SHIELDED_ORDERS.map((o, i) => (
              <li key={i}>
                <span className="mono">{o.id}</span>
                <span className="mono muted">sealed</span>
                <span className="mono muted">•••</span>
              </li>
            ))}
          </ul>
          <div className={styles.safe}>
            ✓ nothing to observe → nothing to front-run · uniform clearing price
          </div>
        </section>
      </div>

      <p className="muted" style={{ fontSize: "0.82rem", marginTop: "1.5rem" }}>
        Placeholder visualization. Live wiring: submit sealed intents to the PER
        node, run a batch-coordinator match, then commit + undelegate results
        back to L1.
      </p>
    </>
  );
}
