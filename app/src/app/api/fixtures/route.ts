// Thin proxy so the browser never sees TXLINE_JWT / TXLINE_API_TOKEN.
// GET /api/fixtures -> LiveFixture[] (live /fixtures/snapshot window merged
// over the verified static fallback; 5-min server cache in txlineFixtures).

import { NextResponse } from "next/server";
import { getLiveFixtures } from "@/lib/txlineFixtures";

export async function GET() {
  return NextResponse.json(await getLiveFixtures());
}
