// Quick Playwright smoke check — launches headless Chromium, hits a route,
// and saves a screenshot so Claude can visually verify pages render without
// needing (or touching) a real wallet extension.
//
// Usage: bun run scripts/screenshot.ts [path] [outfile]
import { chromium } from "@playwright/test";

const path = process.argv[2] ?? "/";
const out = process.argv[3] ?? "/tmp/onyx-screenshot.png";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const url = `http://localhost:3000${path}`;
const res = await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
console.log(`GET ${url} -> ${res?.status()}`);
await page.screenshot({ path: out, fullPage: true });
console.log(`saved: ${out}`);
await browser.close();
