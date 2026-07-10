import { MarketDetail } from "@/components/market/MarketDetail";

export default async function MarketPage({
  params,
}: {
  params: Promise<{ pda: string }>;
}) {
  const { pda } = await params;
  return <MarketDetail pda={pda} />;
}

export function generateMetadata() {
  return { title: "ONYX — Market" };
}

export const revalidate = 0;
