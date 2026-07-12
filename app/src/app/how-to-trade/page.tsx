// How to trade — the exact click path, in plain English, with the honest
// under-the-hood mapping for anyone who wants it. Static page, no data.

import Link from "next/link";
import styles from "./howto.module.css";

const STEPS = [
  {
    n: "1",
    title: "Connect your wallet",
    body: "Click “Connect Wallet” (top right) and pick your wallet — Phantom, Solflare, anything Solana. Nothing is signed yet; connecting just shares your public address.",
  },
  {
    n: "2",
    title: "Get devnet USDC",
    body: "Open the Vault → Add funds. “Get free devnet USDC” mints test money instantly (no signature), or “Buy with SOL” swaps devnet SOL for USDC in one atomic transaction (one signature). This is a devnet build — none of it is real money.",
  },
  {
    n: "3",
    title: "Pick a side",
    body: "Click Yes or No on any market card (or open the market page for charts, live scores, and recent trades). Enter how much USDC to spend — you'll see exactly how many outcome tokens you'll get and the minimum you'll accept, enforced on-chain.",
  },
  {
    n: "4",
    title: "One approval — then everything is instant",
    body: "Your first buy on a market asks for ONE wallet approval: it moves your USDC into the market's escrow and turns on 1-click trading. Every buy and sell after that confirms in about a second with no popups and no gas.",
  },
  {
    n: "5",
    title: "Sell anytime, or hold to the end",
    body: "The pool is always the counterparty — sell part or all of your position whenever the price moves your way. Prices update with every trade; nothing is simulated.",
  },
  {
    n: "6",
    title: "Withdraw your winnings",
    body: "When the match ends, the market settles against TxLINE's own on-chain oracle — not us. Winnings show up in your Vault as “ready to withdraw”; one approval sends them from the market's escrow straight to your wallet.",
  },
] as const;

export default function HowToTradePage() {
  return (
    <div className={styles.page}>
      <h1>How to trade</h1>
      <p className="muted">Six steps, two wallet approvals total — everything in between is instant.</p>

      <ol className={styles.steps}>
        {STEPS.map((s) => (
          <li key={s.n} className={`card ${styles.step}`}>
            <span className={styles.num}>{s.n}</span>
            <div>
              <h3>{s.title}</h3>
              <p className="muted">{s.body}</p>
            </div>
          </li>
        ))}
      </ol>

      <div className={`card ${styles.underHood}`}>
        <h3>Under the hood (for the curious)</h3>
        <p className="muted">
          &ldquo;One approval&rdquo; sends a single transaction that mints a scoped MagicBlock session key
          (it can <strong>only</strong> call the swap instruction — the program rejects it on every
          funds-moving path), opens your position account, escrows your deposit in a program-owned vault, and
          delegates the accounts to an Ephemeral Rollup where trades confirm in ~1s with validator-sponsored
          fees. Withdrawals always require your wallet&apos;s signature. Settlement is a CPI into TxLINE&apos;s{" "}
          <code>validate_stat</code> against a Merkle proof of the real match stats — no admin key decides
          outcomes, and every settlement is <Link href="/markets">verifiable from public RPC</Link>.
        </p>
        <p className="muted" style={{ marginTop: 8 }}>
          Want MEV-proof execution instead of continuous prices? <Link href="/demo/mev">See sealed-batch markets →</Link>
        </p>
      </div>
    </div>
  );
}
