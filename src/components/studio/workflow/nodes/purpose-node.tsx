"use client";

import type { NodeProps } from "@xyflow/react";
import { Handle, Position } from "@xyflow/react";
import { Sparkles } from "lucide-react";
import { memo } from "react";
import { cn } from "@/lib/utils";
import type { WorkflowNodeData } from "@/lib/studio/workflow-store";

type PurposeNodeProps = NodeProps & { data: WorkflowNodeData; id: string };

export const PurposeNode = memo(({ data, selected }: PurposeNodeProps) => {
  return (
    <div
      className={cn(
        "relative w-56 rounded-xl border-2 bg-card px-4 py-3 shadow-sm transition-all",
        selected ? "border-blue-500 shadow-md shadow-blue-500/20" : "border-blue-500/30",
      )}
    >
      <div className="mb-1.5 flex items-center gap-2">
        <div className="rounded-lg bg-blue-500/10 p-1">
          <Sparkles className="size-3.5 text-blue-500" />
        </div>
        <span className="text-[10px] font-medium uppercase tracking-wider text-blue-500">
          Purpose
        </span>
      </div>

      <p className="text-xs font-medium leading-snug">
        {data.name || data.label || "What's this bundle for?"}
      </p>

      {data.description && (
        <p className="mt-1 line-clamp-2 text-[10px] text-muted-foreground">
          {data.description}
        </p>
      )}

      <Handle type="source" position={Position.Right} id="right" className="!bg-blue-500 !w-3 !h-3 !border-2 !border-background" />
    </div>
  );
});

PurposeNode.displayName = "PurposeNode";
