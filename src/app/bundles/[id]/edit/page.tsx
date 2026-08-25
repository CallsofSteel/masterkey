"use client";

// Masterkey — Bundle Studio canvas page (spec §7.1). Loads a bundle into the Jotai atoms via
// loadWorkflowAtom (→ GET /api/studio/bundles/[id]) and renders the ported @xyflow/react canvas. Must
// wrap in <ReactFlowProvider> because WorkflowCanvas calls useReactFlow() above the <ReactFlow> element
// (Flow provided this in its page; the port doesn't). Desktop-first; small screens get a notice.
// Autosave is handled inside the Jotai store (autosaveAtom → api.workflow.update → PATCH §5.1).

import { useEffect } from "react";
import { useParams } from "next/navigation";
import { ReactFlowProvider } from "@xyflow/react";
import { useSetAtom } from "jotai";
import { Monitor } from "lucide-react";
import { WorkflowCanvas } from "@/components/studio/workflow/workflow-canvas";
import { loadWorkflowAtom } from "@/lib/studio/workflow-store";

export default function EditBundlePage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const load = useSetAtom(loadWorkflowAtom);

  useEffect(() => {
    if (id) void load(id);
  }, [id, load]);

  return (
    <>
      <div className="fixed inset-0 z-0 hidden lg:block">
        <ReactFlowProvider>
          <WorkflowCanvas />
        </ReactFlowProvider>
      </div>
      <div className="flex h-[100dvh] flex-col items-center justify-center gap-3 px-8 text-center lg:hidden">
        <Monitor className="size-8 text-muted-foreground" />
        <p className="text-sm font-medium">The Bundle Studio builder needs a larger screen</p>
        <p className="max-w-xs text-sm text-muted-foreground">Open this on a desktop to edit the canvas. You can still run and favorite bundles from the library on any device.</p>
      </div>
    </>
  );
}
