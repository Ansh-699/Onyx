// Country name → flag emoji for TxLINE participant names. Honest fallback:
// unknown names get no flag (never a wrong one).

const FLAGS: Record<string, string> = {
  Argentina: "🇦🇷",
  Australia: "🇦🇺",
  Belgium: "🇧🇪",
  Brazil: "🇧🇷",
  Croatia: "🇭🇷",
  England: "🏴󠁧󠁢󠁥󠁮󠁧󠁿",
  France: "🇫🇷",
  Germany: "🇩🇪",
  Italy: "🇮🇹",
  Japan: "🇯🇵",
  Mexico: "🇲🇽",
  Morocco: "🇲🇦",
  Myanmar: "🇲🇲",
  Netherlands: "🇳🇱",
  Norway: "🇳🇴",
  Portugal: "🇵🇹",
  Senegal: "🇸🇳",
  Spain: "🇪🇸",
  Switzerland: "🇨🇭",
  Uruguay: "🇺🇾",
  USA: "🇺🇸",
  Vietnam: "🇻🇳",
  Wales: "🏴󠁧󠁢󠁷󠁬󠁳󠁿",
};

export function flagFor(participant: string): string {
  return FLAGS[participant.trim()] ?? "";
}

/** "France vs Spain" → "🇫🇷 France vs Spain 🇪🇸" (flags only when known). */
export function flaggedMatchName(p1: string, p2: string): string {
  const f1 = flagFor(p1);
  const f2 = flagFor(p2);
  return `${f1 ? `${f1} ` : ""}${p1} vs ${p2}${f2 ? ` ${f2}` : ""}`;
}
