"use client";

// Masterkey — Bundle Studio empty-canvas welcome node. Rebranded from Flow/AgentCash/Claude-Code to
// Masterkey (spec §3.4/§7.4). Shown when the canvas has no real nodes; the button opens the node palette.

import type { NodeProps } from "@xyflow/react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";

type AddNodeData = {
  onClick?: () => void;
};

export function AddNode({ data }: NodeProps & { data?: AddNodeData }) {
  return (
    <div className="flex flex-col items-center justify-center gap-6 rounded-lg border border-dashed border-border bg-background/50 p-8 backdrop-blur-sm">
      <div className="text-center">
        <h1 className="mb-2 text-2xl font-bold">Bundle Studio</h1>
        <p className="max-w-xs text-sm text-muted-foreground">
          Build a reusable multi-step bundle. Add nodes, wire them together, then run it with{" "}
          <code className="font-mono">/</code> — Masterkey runs it and pays per call for you.
        </p>
      </div>
      <Button className="gap-2 shadow-lg" onClick={data?.onClick} size="default">
        <Plus className="size-4" />
        Add a node
      </Button>
    </div>
  );
}
