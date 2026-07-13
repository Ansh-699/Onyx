// scratch: why does <wallet> see "insufficient balance"? (bun scripts/check-wallet.ts <pubkey>)
import { PublicKey } from "@solana/web3.js";
import { getConnection, getConfigUsdcMint, listAmmPositionsForOwner } from "../src/lib/onchain";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

const owner = new PublicKey(process.argv[2] ?? "anshxnbjGiUpsZpnx3c6LrK2vt8zt54vLMvY3C7Locm");
const conn = getConnection();
const mint = await getConfigUsdcMint();
if (!mint) throw new Error("no config");
const ata = getAssociatedTokenAddressSync(mint, owner, true);
const bal = await conn.getTokenAccountBalance(ata).catch(() => null);
console.log("wallet tUSDC:", bal?.value.uiAmountString ?? "no ATA");
const positions = await listAmmPositionsForOwner(owner);
for (const p of positions) {
  console.log(
    `market ${p.market.slice(0, 8)}… delegated=${p.delegated} usdcAvailable=${Number(p.usdcAvailable) / 1e6} tokensA=${Number(p.tokensA) / 1e6} tokensB=${Number(p.tokensB) / 1e6}`,
  );
}
