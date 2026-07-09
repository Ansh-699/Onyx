// Thin proxy so the browser never sees TXLINE_JWT / TXLINE_API_TOKEN.
// GET /api/scores/12345 -> { fixtureId, p1Goals, p2Goals, seq, fetchedAt, source }

import { NextRequest, NextResponse } from "next/server";
import { getFixtureScore } from "@/lib/txlineScores";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ fixtureId: string }> }) {
  const { fixtureId } = await params;
  const id = Number(fixtureId);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "invalid fixtureId" }, { status: 400 });
  }
  const score = await getFixtureScore(id);
  return NextResponse.json(score);
}
