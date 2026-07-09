import type { Metadata } from "next";
import type { ReactNode } from "react";
import { OnyxWalletProvider } from "@/components/WalletProvider";
import { Nav } from "@/components/Nav";
import "./globals.css";

export const metadata: Metadata = {
  title: "ONYX — verifiable in-play markets",
  description:
    "MEV-proof, on-chain-verifiable World Cup prediction markets on Solana devnet.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <OnyxWalletProvider>
          <Nav />
          <main>{children}</main>
        </OnyxWalletProvider>
      </body>
    </html>
  );
}
