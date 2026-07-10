// Creates one fresh sealed market with generous commit/reveal windows for
// the browser-driven acceptance proof (services/ingestion/src/
// er_browser_proof.ts drives the actual clicking). Market creation itself
// is not re-proven here through the browser — it was already proven
// browser-driven in an earlier session's classic-flow testing; this script
// only sets up the fixture so the browser proof can focus on the NEW
// ER-fast lifecycle (deposit/delegate/bet/resize/cancel/match/settle/
// withdraw), which is what's actually new and untested through a wallet.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as ix from "../src/lib/instructions";

const base = new Connection("https://api.devnet.solana.com", "confirmed");
const ONYX = new PublicKey("4LpMzq6wXYFMzxgbyMyN2ja4EQhPsYGHSCAvjwzA18MB");
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("/home/anshtyagi/.config/solana/id.json", "utf8"))));

const u32le = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u64le = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const i64le = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigInt64LE(n); return b; };
const sha256 = (...bufs: Buffer[]) => { const h = createHash("sha256"); for (const b of bufs) h.update(b); return h.digest(); };

async function main() {
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], ONYX);
  const configInfo = await base.getAccountInfo(configPda);
  const usdcMint = new PublicKey(configInfo!.data.subarray(40, 72));

  const fixtureId = 18179550n; // real, named-in-code World Cup fixture with a captured settle proof
  const now = BigInt(Math.floor(Date.now() / 1000));
  const deadline = now + 3600n;
  const commitEndTs = now + BigInt(process.argv[2] ?? "240");
  const revealEndTs = commitEndTs + BigInt(process.argv[3] ?? "90");
  const paramsHash = sha256(u64le(fixtureId), u32le(1), u32le(0), Buffer.from([0xff]), Buffer.from([0]), i64le(2n), i64le(deadline));
  const fixtureLe = u64le(fixtureId);
  const [market] = PublicKey.findProgramAddressSync([Buffer.from("market"), fixtureLe, paramsHash], ONYX);
  const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), market.toBuffer()], ONYX);

  if (await base.getAccountInfo(market)) {
    console.log("EXISTS", market.toBase58());
    return;
  }

  const openArgs = Buffer.concat([
    fixtureLe, u32le(1), u32le(0), Buffer.from([0xff]), Buffer.from([0]),
    i64le(2n), i64le(deadline), paramsHash, i64le(commitEndTs), i64le(revealEndTs),
  ]);
  const openIx = new TransactionInstruction({
    programId: ONYX,
    keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: false },
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: usdcMint, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: require("@solana/web3.js").SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([15]), openArgs]),
  });
  const tx = new Transaction().add(openIx);
  const bh = await base.getLatestBlockhash("confirmed");
  tx.recentBlockhash = bh.blockhash;
  tx.feePayer = admin.publicKey;
  tx.sign(admin);
  const sig = await base.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  await base.confirmTransaction({ signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, "confirmed");

  console.log("CREATED", market.toBase58());
  console.log("sig", sig);
  console.log("commitEndTs", commitEndTs.toString(), new Date(Number(commitEndTs) * 1000).toISOString());
  console.log("revealEndTs", revealEndTs.toString(), new Date(Number(revealEndTs) * 1000).toISOString());
}
main().catch((e) => { console.error(e); process.exit(1); });
