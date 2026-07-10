import type { Metadata } from "next";
import type { ReactNode } from "react";
import { OnyxWalletProvider } from "@/components/WalletProvider";
import { QueryProvider } from "@/components/QueryProvider";
import { Nav } from "@/components/Nav";
import { NO_FLASH_SCRIPT } from "@/components/ThemeToggle";
import "./globals.css";

export const metadata: Metadata = {
  title: "ONYX — verifiable prediction markets on Solana",
  description:
    "Sealed, MEV-proof World Cup prediction markets with trustless oracle settlement — every outcome independently verifiable on-chain. Solana devnet.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Must run before first paint to avoid a flash of the wrong theme —
            sets data-theme from localStorage or system preference. */}
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH_SCRIPT }} />
      </head>
      <body>
        <QueryProvider>
          <OnyxWalletProvider>
            <Nav />
            <main>{children}</main>
          </OnyxWalletProvider>
        </QueryProvider>
      </body>
    </html>
  );
}
