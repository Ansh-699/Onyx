"use client";

import dynamic from "next/dynamic";

// WalletMultiButton touches `window`, so load it client-only to avoid SSR issues.
export const WalletButton = dynamic(
  async () =>
    (await import("@solana/wallet-adapter-react-ui")).WalletMultiButton,
  { ssr: false },
);
