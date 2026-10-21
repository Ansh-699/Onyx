import { describe, expect, it } from "bun:test";
import { Keypair } from "@solana/web3.js";
import { BadInput, apiError, positiveBigint, pubkey, rateLimited } from "./apiGuard";

describe("rateLimited", () => {
  it("allows max calls per window, then blocks, then resets", () => {
    const k = "t:window";
    expect([1, 2, 3].map(() => rateLimited(k, 3, 1_000, 0))).toEqual([false, false, false]);
    expect(rateLimited(k, 3, 1_000, 500)).toBe(true);
    expect(rateLimited(k, 3, 1_000, 1_000)).toBe(false); // window rolled over
  });

  it("counts keys independently", () => {
    expect(rateLimited("t:a", 1, 1_000, 0)).toBe(false);
    expect(rateLimited("t:b", 1, 1_000, 0)).toBe(false);
    expect(rateLimited("t:a", 1, 1_000, 1)).toBe(true);
  });
});

describe("input parsing", () => {
  it("pubkey rejects garbage as BadInput, accepts a real key", () => {
    expect(() => pubkey("nope", "user")).toThrow(BadInput);
    const k = Keypair.generate().publicKey;
    expect(pubkey(k.toBase58(), "user").equals(k)).toBe(true);
  });

  it("positiveBigint enforces 1..=max and digits only", () => {
    expect(positiveBigint("5", "n", 10n)).toBe(5n);
    for (const bad of ["0", "11", "-1", "1.5", "1e3", "abc", "", undefined]) {
      expect(() => positiveBigint(bad, "n", 10n)).toThrow(BadInput);
    }
  });
});

describe("apiError", () => {
  it("maps BadInput to 400 with its message and anything else to an opaque 500", async () => {
    const bad = apiError(new BadInput("invalid user"));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ ok: false, error: "invalid user" });

    const origErr = console.error;
    console.error = () => {};
    const boom = apiError(new Error("https://rpc.example/?api-key=secret exploded"));
    console.error = origErr;
    expect(boom.status).toBe(500);
    expect(await boom.json()).toEqual({ ok: false, error: "internal error" });
  });
});
