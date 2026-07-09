import Link from "next/link";
import { WalletButton } from "./WalletButton";
import styles from "./Nav.module.css";

export function Nav() {
  return (
    <header className={styles.nav}>
      <div className={styles.brand}>
        <Link href="/" className={styles.logo}>
          ONYX
        </Link>
        <span className={styles.badge}>devnet</span>
      </div>
      <nav className={styles.links}>
        <Link href="/">Lobby</Link>
        <Link href="/create">Create</Link>
        <Link href="/demo/mev">MEV Demo</Link>
      </nav>
      <div className={styles.wallet}>
        <WalletButton />
      </div>
    </header>
  );
}
