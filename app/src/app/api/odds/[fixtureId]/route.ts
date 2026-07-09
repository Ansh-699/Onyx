// Thin proxy so the browser never sees TxLINE credentials.
// GET /api/odds/12345 -> ReferenceOdds (full-game 1X2 implied %, or
// source:"unavailable" when TxLINE hasn't published odds for the fixture).

import { NextRequest, NextResponse } from "next/server";
import { getReferenceOdds } from "@/lib/txlineOdds";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ fixtureId: string }> }) {
  const { fixtureId } = await params;
  const id = Number(fixtureId);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "invalid fixtureId" }, { status: 400 });
  }
  return NextResponse.json(await getReferenceOdds(id));
}
