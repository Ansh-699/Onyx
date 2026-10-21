import { describe, expect, it, afterEach } from "bun:test";
import { Keypair } from "@solana/web3.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadServerKeypair } from "./serverKeypair";

const original = process.env.ANCHOR_WALLET;
afterEach(() => {
  if (original === undefined) delete process.env.ANCHOR_WALLET;
  else process.env.ANCHOR_WALLET = original;
});

describe("loadServerKeypair", () => {
  const kp = Keypair.generate();
  const json = JSON.stringify(Array.from(kp.secretKey));

  it("reads a keypair file path (local dev)", () => {
    const p = join(mkdtempSync(join(tmpdir(), "kp-")), "id.json");
    writeFileSync(p, json);
    process.env.ANCHOR_WALLET = p;
    expect(loadServerKeypair().publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  it("reads the secret-key array inline (Vercel, no filesystem)", () => {
    process.env.ANCHOR_WALLET = json;
    expect(loadServerKeypair().publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  it("throws when unset rather than signing with something else", () => {
    delete process.env.ANCHOR_WALLET;
    expect(() => loadServerKeypair()).toThrow(/ANCHOR_WALLET not set/);
  });
});
