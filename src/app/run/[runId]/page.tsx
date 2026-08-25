// Masterkey — /run/[runId]: the durable run view (W5/W8). Thin server wrapper that resolves the id
// and renders the client RunView (which subscribes via the §6 seam and gates anonymous users).

import { RunView } from "@/components/run/RunView";

export default async function RunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  return <RunView runId={runId} />;
}
