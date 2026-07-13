// scratch: stage-by-stage timing of the lobby's data path (bun scripts/time-reads.ts)
import { listMarkets, getAmmPoolsForMarkets } from "../src/lib/onchain";

let t = Date.now();
const markets = await listMarkets();
console.log("listMarkets:", Date.now() - t, "ms,", markets.length, "markets");

t = Date.now();
const pools = await getAmmPoolsForMarkets(markets.map((m) => m.pda));
console.log("getAmmPoolsForMarkets:", Date.now() - t, "ms,", pools.size, "pools");
