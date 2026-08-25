"use client";

// Masterkey — Bundle Studio loop node (spec §7.4). v1 loop semantics: repeat the body nodes for each item
// in a collection (overRef) / until a condition. Rendered in the recipe as an explicit loop instruction
// (compile.ts §1.2). Mirrors the other simple node renderers.

import type { NodeProps } from "@xyflow/react";
import { Handle, Position } from "@xyflow/react";
import { Repeat } from "lucide-react";
import { memo } from "react";
import { cn } from "@/lib/utils";
import type { WorkflowNodeData } from "@/lib/studio/workflow-store";

type LoopNodeProps = NodeProps & { data: WorkflowNodeData; id: string };

export const LoopNode = memo(({ data, selected }: LoopNodeProps) => {
  return (
    <div
      className={cn(
        "relative w-56 rounded-xl border-2 bg-card px-4 py-3 shadow-sm transition-all",
        selected ? "border-violet-500 shadow-md shadow-violet-500/20" : "border-violet-500/30",
      )}
    >
      <Handle type="target" position={Position.Left} id="left" className="!size-3 !border-2 !border-background !bg-violet-500" />

      <div className="mb-1.5 flex items-center gap-2">
        <div className="rounded-lg bg-violet-500/10 p-1">
          <Repeat className="size-3.5 text-violet-500" />
        </div>
        <span className="text-[10px] font-medium uppercase tracking-wider text-violet-500">Loop</span>
      </div>

      <p className="text-xs font-medium leading-snug">{data.label || "Repeat steps"}</p>
      {data.overRef && <p className="mt-1 line-clamp-1 text-[10px] text-muted-foreground">for each {data.overRef}</p>}
      {data.until && <p className="line-clamp-1 text-[10px] text-muted-foreground">until {data.until}</p>}

      <Handle type="source" position={Position.Right} id="right" className="!size-3 !border-2 !border-background !bg-violet-500" />
    </div>
  );
});

LoopNode.displayName = "LoopNode";
