"use client";

import {
  ConnectionMode,
  MiniMap,
  type Node,
  type NodeMouseHandler,
  type OnConnect,
  type OnConnectStartParams,
  useReactFlow,
  type Connection as XYFlowConnection,
  type Edge as XYFlowEdge,
} from "@xyflow/react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas } from "@/components/studio/ai-elements/canvas";
import { Connection } from "@/components/studio/ai-elements/connection";
import { Controls } from "@/components/studio/ai-elements/controls";
import { WorkflowToolbar } from "@/components/studio/workflow/workflow-toolbar";
import "@xyflow/react/dist/style.css";

import { nanoid } from "nanoid";
import {
  addNodeAtom,
  autosaveAtom,
  changeTypeNodeIdAtom,
  currentWorkflowIdAtom,
  edgesAtom,
  hasUnsavedChangesAtom,
  isGeneratingAtom,
  isPanelAnimatingAtom,
  isTransitioningFromHomepageAtom,
  nodesAtom,
  onEdgesChangeAtom,
  onNodesChangeAtom,
  propertiesPanelActiveTabAtom,
  rightPanelWidthAtom,
  selectedEdgeAtom,
  selectedNodeAtom,
  serviceBrowserAtom,
  showMinimapAtom,
  updateNodeDataAtom,
  type WorkflowNode,
} from "@/lib/studio/workflow-store";
import { Edge } from "../ai-elements/edge";
import { Panel } from "../ai-elements/panel";
import { NodePalette, type PaletteAdd } from "@/components/studio/node-palette";
import { ServiceBrowserModal } from "@/components/studio/service-browser";
import { ChatBar } from "@/components/studio/chat-bar";
import { TestRunDrawer } from "./test-run-drawer";
import { NodeConfigPanel } from "./node-config-panel";
import { validateCanvas } from "@/lib/studio/validate";
import { TriangleAlert } from "lucide-react";
import { ActionNode } from "./nodes/action-node";
import { AddNode } from "./nodes/add-node";
import { DecisionNode } from "./nodes/decision-node";
import { InputNode } from "./nodes/input-node";
import { InstructionNode } from "./nodes/instruction-node";
import { LoopNode } from "./nodes/loop-node";
import { OutputNode } from "./nodes/output-node";
import { PurposeNode } from "./nodes/purpose-node";
import { ServiceNode } from "./nodes/service-node";
import { TriggerNode } from "./nodes/trigger-node";
import {
  type ContextMenuState,
  useContextMenuHandlers,
  WorkflowContextMenu,
} from "./workflow-context-menu";

const edgeTypes = {
  animated: Edge.Animated,
  temporary: Edge.Temporary,
};

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: React Flow canvas requires complex setup
export function WorkflowCanvas() {
  const [nodes] = useAtom(nodesAtom);
  const [edges, setEdges] = useAtom(edgesAtom);
  const [isGenerating] = useAtom(isGeneratingAtom);
  const currentWorkflowId = useAtomValue(currentWorkflowIdAtom);
  const [showMinimap] = useAtom(showMinimapAtom);
  const rightPanelWidth = useAtomValue(rightPanelWidthAtom);
  const setRightPanelWidth = useSetAtom(rightPanelWidthAtom);
  const selectedNodeId = useAtomValue(selectedNodeAtom);
  const selectedEdgeId = useAtomValue(selectedEdgeAtom);
  const isPanelAnimating = useAtomValue(isPanelAnimatingAtom);
  const [isTransitioningFromHomepage, setIsTransitioningFromHomepage] = useAtom(
    isTransitioningFromHomepageAtom
  );
  const onNodesChange = useSetAtom(onNodesChangeAtom);
  const onEdgesChange = useSetAtom(onEdgesChangeAtom);
  const setSelectedNode = useSetAtom(selectedNodeAtom);
  const setSelectedEdge = useSetAtom(selectedEdgeAtom);
  const addNode = useSetAtom(addNodeAtom);
  const setHasUnsavedChanges = useSetAtom(hasUnsavedChangesAtom);
  const triggerAutosave = useSetAtom(autosaveAtom);
  const setActiveTab = useSetAtom(propertiesPanelActiveTabAtom);
  const { screenToFlowPosition, fitView, getViewport, setViewport } =
    useReactFlow();

  // Node palette — opened by Cmd+K (adds at viewport center) OR by dragging a handle to empty canvas. In
  // the drag case `pendingConnect` carries the source node + drop position, so the chosen node is created
  // THERE and auto-connected to the source (§7.3). This is how you pick the node KIND (service, input,
  // decision, output, instruction, loop) when extending a flow — not just a service.
  const [paletteOpen, setPaletteOpen] = useState(false);
  // `sourceHandle` MUST survive the drag: a decision node's per-option handles are keyed by option id, and
  // compile.ts resolves "if <option> → go to step N" by matching edge.sourceHandle to that id. Dropping it
  // silently degrades a branch to "continue" (no routing), so every edge we synthesize below preserves it.
  const [pendingConnect, setPendingConnect] = useState<{ sourceId: string; sourceHandle?: string | null; position: { x: number; y: number } } | null>(null);
  const serviceBrowser = useAtomValue(serviceBrowserAtom);
  const setServiceBrowser = useSetAtom(serviceBrowserAtom);
  const updateNodeData = useSetAtom(updateNodeDataAtom);
  const changeTypeNodeId = useAtomValue(changeTypeNodeIdAtom);
  const setChangeTypeNodeId = useSetAtom(changeTypeNodeIdAtom);
  const handlePaletteAdd = useCallback(
    (a: PaletteAdd) => {
      // "Change type" mode (from a node's config panel): re-type THIS node instead of creating a new one.
      if (changeTypeNodeId) {
        const id = changeTypeNodeId;
        setChangeTypeNodeId(null);
        if (a.kind === "service" && !a.serviceId) {
          setServiceBrowser({ mode: "set", nodeId: id });
          return;
        }
        updateNodeData({
          id,
          data: {
            type: a.kind, // updateNodeDataAtom also updates node.type → the right renderer
            ...(a.serviceId ? { serviceId: a.serviceId } : { serviceId: undefined, service: undefined }),
            instruction: undefined,
            question: undefined,
            options: undefined,
            prompt: undefined,
            required: undefined,
            saveAs: undefined,
            format: undefined,
            template: undefined,
            endpoint: undefined,
            overRef: undefined,
            until: undefined,
          },
        });
        return;
      }
      // Generic "Service" (no specific service yet) → open the visual browser to pick one (§7.3). A
      // palette search result already carries a serviceId → create directly (the quick path).
      if (a.kind === "service" && !a.serviceId) {
        setServiceBrowser({ mode: "create", sourceId: pendingConnect?.sourceId, sourceHandle: pendingConnect?.sourceHandle, position: pendingConnect?.position });
        setPendingConnect(null);
        return;
      }
      const position =
        pendingConnect?.position ??
        (typeof window !== "undefined"
          ? screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
          : { x: 240, y: 160 });
      const newNode: WorkflowNode = {
        id: nanoid(),
        type: a.kind,
        position,
        data: { label: a.label, type: a.kind, ...(a.serviceId ? { serviceId: a.serviceId } : {}) },
        selected: true,
      };
      addNode(newNode);
      if (pendingConnect) {
        setEdges((prev) => [...prev, { id: nanoid(), source: pendingConnect.sourceId, ...(pendingConnect.sourceHandle ? { sourceHandle: pendingConnect.sourceHandle } : {}), target: newNode.id, type: "animated" }]);
        setHasUnsavedChanges(true);
        triggerAutosave({ immediate: true });
      }
      setSelectedNode(newNode.id);
      setActiveTab("properties");
      setPendingConnect(null);
    },
    [pendingConnect, screenToFlowPosition, addNode, setEdges, setSelectedNode, setActiveTab, setHasUnsavedChanges, triggerAutosave, setServiceBrowser, changeTypeNodeId, setChangeTypeNodeId, updateNodeData],
  );

  // "Change type" requested from a node's config panel → open the palette (re-type mode).
  useEffect(() => {
    if (changeTypeNodeId) setPaletteOpen(true);
  }, [changeTypeNodeId]);

  // Service browser modal (§7.3) — on select, either CREATE a service node (optionally connected to the
  // drag source) or SET the service on an existing node, depending on the open request.
  const handleServiceSelect = useCallback(
    (serviceId: string, name: string) => {
      const req = serviceBrowser;
      if (!req) return;
      if (req.mode === "set") {
        // Switch the service; clear the old snapshot so the config panel re-resolves the new one.
        updateNodeData({
          id: req.nodeId,
          data: { serviceId, label: name, service: undefined, backendProviderId: undefined, operation: undefined, endpoint: undefined },
        });
        setSelectedNode(req.nodeId);
      } else {
        const position =
          req.position ??
          (typeof window !== "undefined"
            ? screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
            : { x: 240, y: 160 });
        const newNode: WorkflowNode = {
          id: nanoid(),
          type: "service",
          position,
          data: { label: name, type: "service", serviceId },
          selected: true,
        };
        addNode(newNode);
        if (req.sourceId) {
          const sourceId = req.sourceId;
          const sourceHandle = req.sourceHandle;
          setEdges((prev) => [...prev, { id: nanoid(), source: sourceId, ...(sourceHandle ? { sourceHandle } : {}), target: newNode.id, type: "animated" }]);
          setHasUnsavedChanges(true);
          triggerAutosave({ immediate: true });
        }
        setSelectedNode(newNode.id);
      }
      setActiveTab("properties");
      setServiceBrowser(null);
    },
    [serviceBrowser, updateNodeData, screenToFlowPosition, addNode, setEdges, setSelectedNode, setActiveTab, setHasUnsavedChanges, triggerAutosave, setServiceBrowser],
  );

  // Inline validation surface (§7.6) — recomputed as the graph changes.
  const issues = useMemo(() => validateCanvas(nodes, edges), [nodes, edges]);

  // Open the desktop config panel (and shrink the canvas to make room) whenever a node/edge is selected.
  // The panel (NodeConfigPanel → SkillNodeConfig) is where every node's fields are edited (§7.4).
  const configOpen = !!selectedNodeId || !!selectedEdgeId;
  useEffect(() => {
    setRightPanelWidth(configOpen ? "22rem" : null);
  }, [configOpen, setRightPanelWidth]);

  // Flush any pending (debounced) autosave when leaving the canvas, so navigating away never loses the
  // last edits — there's no Save button; changes autosave (§7.7).
  useEffect(() => {
    return () => {
      triggerAutosave({ immediate: true });
    };
  }, [triggerAutosave]);

  const connectingNodeId = useRef<string | null>(null);
  const connectingHandleId = useRef<string | null>(null);
  const justCreatedNodeFromConnection = useRef(false);
  const viewportInitialized = useRef(false);
  const [isCanvasReady, setIsCanvasReady] = useState(false);
  const [contextMenuState, setContextMenuState] =
    useState<ContextMenuState>(null);

  // Context menu handlers
  const { onNodeContextMenu, onEdgeContextMenu, onPaneContextMenu } =
    useContextMenuHandlers(screenToFlowPosition, setContextMenuState);

  const closeContextMenu = useCallback(() => {
    setContextMenuState(null);
  }, []);

  // Track which workflow we've fitted view for to prevent re-running
  const fittedViewForWorkflowRef = useRef<string | null | undefined>(undefined);
  // Track if we have real nodes (not just placeholder "add" node)
  const hasRealNodes = nodes.some((n) => n.type !== "add");
  const hadRealNodesRef = useRef(false);
  // Pre-shift viewport when transitioning from homepage (before sidebar animates)
  const hasPreShiftedRef = useRef(false);
  useEffect(() => {
    if (isTransitioningFromHomepage && !hasPreShiftedRef.current) {
      hasPreShiftedRef.current = true;

      // Check if sidebar is collapsed from cookie (atom may not be initialized yet)
      const collapsedCookie = document.cookie
        .split("; ")
        .find((row) => row.startsWith("sidebar-collapsed="));
      const isCollapsed = collapsedCookie?.split("=")[1] === "true";

      // Skip if sidebar is collapsed - content should stay centered
      if (isCollapsed) {
        return;
      }

      // Shift viewport left to center content in the future visible area
      // Default sidebar is 30%, so shift by 15% of window width
      const viewport = getViewport();
      const defaultSidebarPercent = 0.3;
      const shiftPixels = (window.innerWidth * defaultSidebarPercent) / 2;
      setViewport(
        { ...viewport, x: viewport.x - shiftPixels },
        { duration: 0 }
      );
    }
  }, [isTransitioningFromHomepage, getViewport, setViewport]);

  // Fit view when workflow changes (only on initial load, not home -> workflow)
  useEffect(() => {
    // Skip if we've already fitted view for this workflow
    if (fittedViewForWorkflowRef.current === currentWorkflowId) {
      return;
    }

    // Skip fitView for homepage -> workflow transition (viewport already set from homepage)
    if (isTransitioningFromHomepage && viewportInitialized.current) {
      fittedViewForWorkflowRef.current = currentWorkflowId;
      setIsCanvasReady(true);
      // Clear the flag after using it
      setIsTransitioningFromHomepage(false);
      return;
    }

    // Use fitView after a brief delay to ensure React Flow and nodes are ready
    setTimeout(() => {
      fitView({ maxZoom: 1, minZoom: 0.5, padding: 0.2, duration: 0 });
      fittedViewForWorkflowRef.current = currentWorkflowId;
      viewportInitialized.current = true;
      // Show canvas immediately so width animation can be seen
      setIsCanvasReady(true);
      // Clear the flag
      setIsTransitioningFromHomepage(false);
    }, 0);
  }, [
    currentWorkflowId,
    fitView,
    isTransitioningFromHomepage,
    setIsTransitioningFromHomepage,
  ]);

  // Fit view when first real node is added on homepage
  useEffect(() => {
    if (currentWorkflowId) {
      return; // Only for homepage
    }
    // Check if we just got our first real node
    if (hasRealNodes && !hadRealNodesRef.current) {
      hadRealNodesRef.current = true;
      // Fit view to center the new node
      setTimeout(() => {
        fitView({ maxZoom: 1, minZoom: 0.5, padding: 0.2, duration: 0 });
        viewportInitialized.current = true;
        setIsCanvasReady(true);
      }, 0);
    } else if (!hasRealNodes) {
      // Reset when back to placeholder only
      hadRealNodesRef.current = false;
    }
  }, [currentWorkflowId, hasRealNodes, fitView]);

  // Keyboard shortcut for fit view (Cmd+/ or Ctrl+/)
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Check for Cmd+/ (Mac) or Ctrl+/ (Windows/Linux)
      if ((event.metaKey || event.ctrlKey) && event.key === "/") {
        event.preventDefault();
        fitView({ padding: 0.2, duration: 300 });
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [fitView]);

  const nodeTypes = useMemo(
    () => ({
      // New skill node types
      purpose: PurposeNode,
      service: ServiceNode,
      instruction: InstructionNode,
      decision: DecisionNode,
      input: InputNode,
      output: OutputNode,
      loop: LoopNode,
      // Legacy types (kept for backward compat)
      trigger: TriggerNode,
      action: ActionNode,
      logic: ActionNode,
      data: ActionNode,
      x402: ActionNode,
      add: AddNode,
    }),
    []
  );

  const isValidConnection = useCallback(
    (connection: XYFlowConnection | XYFlowEdge) => {
      // Ensure we have both source and target
      if (!(connection.source && connection.target)) {
        return false;
      }

      // Prevent self-connections
      if (connection.source === connection.target) {
        return false;
      }

      // Ensure connection is from source handle to target handle
      // sourceHandle should be defined if connecting from a specific handle
      // targetHandle should be defined if connecting to a specific handle
      return true;
    },
    []
  );

  const onConnect: OnConnect = useCallback(
    (connection: XYFlowConnection) => {
      const newEdge = {
        id: nanoid(),
        ...connection,
        type: "animated",
      };
      setEdges([...edges, newEdge]);
      setHasUnsavedChanges(true);
      // Trigger immediate autosave when nodes are connected
      triggerAutosave({ immediate: true });
    },
    [edges, setEdges, setHasUnsavedChanges, triggerAutosave]
  );

  const onNodeClick: NodeMouseHandler = useCallback(
    (_event, node) => {
      setSelectedNode(node.id);
    },
    [setSelectedNode]
  );

  const onConnectStart = useCallback(
    (_event: MouseEvent | TouchEvent, params: OnConnectStartParams) => {
      connectingNodeId.current = params.nodeId;
      connectingHandleId.current = params.handleId; // e.g. a decision option's id — see `pendingConnect`
    },
    []
  );

  const getClientPosition = useCallback((event: MouseEvent | TouchEvent) => {
    const clientX =
      "changedTouches" in event
        ? event.changedTouches[0].clientX
        : event.clientX;
    const clientY =
      "changedTouches" in event
        ? event.changedTouches[0].clientY
        : event.clientY;
    return { clientX, clientY };
  }, []);

  const calculateMenuPosition = useCallback(
    (event: MouseEvent | TouchEvent, clientX: number, clientY: number) => {
      const reactFlowBounds = (event.target as Element)
        .closest(".react-flow")
        ?.getBoundingClientRect();

      const adjustedX = reactFlowBounds
        ? clientX - reactFlowBounds.left
        : clientX;
      const adjustedY = reactFlowBounds
        ? clientY - reactFlowBounds.top
        : clientY;

      return { adjustedX, adjustedY };
    },
    []
  );

  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent) => {
      if (!connectingNodeId.current) {
        return;
      }

      // Get client position first
      const { clientX, clientY } = getClientPosition(event);

      // For touch events, use elementFromPoint to get the actual element at the touch position
      // For mouse events, use event.target as before
      const target =
        "changedTouches" in event
          ? document.elementFromPoint(clientX, clientY)
          : (event.target as Element);

      if (!target) {
        connectingNodeId.current = null;
        connectingHandleId.current = null;
        return;
      }

      const isNode = target.closest(".react-flow__node");
      const isHandle = target.closest(".react-flow__handle");

      if (!(isNode || isHandle)) {
        const sourceId = connectingNodeId.current;
        const { adjustedX, adjustedY } = calculateMenuPosition(event, clientX, clientY);
        const position = screenToFlowPosition({ x: adjustedX, y: adjustedY });
        position.y -= 40;

        // Drag-to-empty opens the node palette at the drop point so the author picks WHAT kind of node to
        // add (service, input, decision, output, instruction, loop) — then it's created + auto-connected to
        // the source. (Replaces Flow's behavior of always dropping a legacy AgentCash "action" node.)
        if (sourceId) {
          setPendingConnect({ sourceId, sourceHandle: connectingHandleId.current, position });
          setPaletteOpen(true);
          justCreatedNodeFromConnection.current = true;
          setTimeout(() => {
            justCreatedNodeFromConnection.current = false;
          }, 100);
        }
      }

      connectingNodeId.current = null;
      connectingHandleId.current = null;
    },
    [getClientPosition, calculateMenuPosition, screenToFlowPosition]
  );

  const onPaneClick = useCallback(() => {
    // Don't deselect if we just created a node from a connection
    if (justCreatedNodeFromConnection.current) {
      return;
    }
    setSelectedNode(null);
    setSelectedEdge(null);
    closeContextMenu();
  }, [setSelectedNode, setSelectedEdge, closeContextMenu]);

  const onSelectionChange = useCallback(
    ({ nodes: selectedNodes }: { nodes: Node[] }) => {
      // Don't clear selection if we just created a node from a connection
      if (justCreatedNodeFromConnection.current && selectedNodes.length === 0) {
        return;
      }

      if (selectedNodes.length === 0) {
        setSelectedNode(null);
      } else if (selectedNodes.length === 1) {
        setSelectedNode(selectedNodes[0].id);
      }
    },
    [setSelectedNode]
  );

  return (
    <div className="relative h-full w-full">
    <div
      className="relative h-full bg-background"
      style={{
        opacity: isCanvasReady ? 1 : 0,
        width: rightPanelWidth ? `calc(100% - ${rightPanelWidth})` : "100%",
        transition: isPanelAnimating
          ? "width 300ms ease-out, opacity 300ms"
          : "opacity 300ms",
      }}
    >
      {/* Toolbar */}
      <div className="pointer-events-auto">
        <WorkflowToolbar workflowId={currentWorkflowId ?? undefined} />
      </div>

      {/* React Flow Canvas */}
      <Canvas
        className="bg-background"
        connectionLineComponent={Connection}
        connectionMode={ConnectionMode.Strict}
        edges={edges}
        edgeTypes={edgeTypes}
        elementsSelectable={!isGenerating}
        isValidConnection={isValidConnection}
        nodes={nodes}
        nodesConnectable={!isGenerating}
        nodesDraggable={!isGenerating}
        nodeTypes={nodeTypes}
        onConnect={isGenerating ? undefined : onConnect}
        onConnectEnd={isGenerating ? undefined : onConnectEnd}
        onConnectStart={isGenerating ? undefined : onConnectStart}
        onEdgeContextMenu={isGenerating ? undefined : onEdgeContextMenu}
        onEdgesChange={isGenerating ? undefined : onEdgesChange}
        onNodeClick={isGenerating ? undefined : onNodeClick}
        onNodeContextMenu={isGenerating ? undefined : onNodeContextMenu}
        onNodesChange={isGenerating ? undefined : onNodesChange}
        onPaneClick={onPaneClick}
        onPaneContextMenu={isGenerating ? undefined : onPaneContextMenu}
        onSelectionChange={isGenerating ? undefined : onSelectionChange}
      >
        <Panel
          className="workflow-controls-panel border-none bg-transparent p-0"
          position="bottom-left"
        >
          <Controls />
        </Panel>
        {showMinimap && (
          <MiniMap bgColor="var(--sidebar)" nodeStrokeColor="var(--border)" />
        )}
      </Canvas>

      {/* Context Menu */}
      <WorkflowContextMenu
        menuState={contextMenuState}
        onClose={closeContextMenu}
      />

      {/* Node palette (Cmd+K or drag-to-empty) — §7.3 */}
      <NodePalette
        open={paletteOpen}
        onOpenChange={(o) => {
          setPaletteOpen(o);
          if (!o) {
            setPendingConnect(null); // closed without picking → drop the pending connection
            setChangeTypeNodeId(null); // …and any pending change-type request
          }
        }}
        onAdd={handlePaletteAdd}
      />

      {/* Visual service browser (§7.3) — opened by the palette/"+"/a blank node to pick a service by browsing */}
      <ServiceBrowserModal open={!!serviceBrowser} onClose={() => setServiceBrowser(null)} onSelect={handleServiceSelect} />

      {/* Inline validation warnings (§7.6) */}
      {issues.length > 0 && (
        <div className="pointer-events-auto absolute bottom-4 right-4 z-40 max-w-xs rounded-lg border border-amber-500/30 bg-card/95 p-3 shadow-lg backdrop-blur">
          <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-amber-600 dark:text-amber-400">
            <TriangleAlert className="size-3.5" /> {issues.length} {issues.length === 1 ? "issue" : "issues"} to fix
          </div>
          <ul className="space-y-1">
            {issues.slice(0, 6).map((iss, i) => (
              <li key={i}>
                <button
                  type="button"
                  className="text-left text-[11px] text-muted-foreground hover:text-foreground"
                  onClick={() => iss.nodeId && setSelectedNode(iss.nodeId)}
                >
                  • {iss.message}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>

      {/* AI build-assist chat bar (§8.3) — edits the live graph via /api/studio/assist. */}
      <ChatBar />

      {/* In-builder test drawer (§9.2/§10.1) — collects inputs, runs the bundle E2E, shows live transcript. */}
      <TestRunDrawer />

      {/* Desktop node/edge config panel (§7.4) — opens in the freed space when something is selected. */}
      {configOpen && (
        <div
          className="absolute right-0 top-0 z-30 h-full overflow-hidden border-l border-border bg-background"
          style={{ width: rightPanelWidth ?? "22rem" }}
        >
          <NodeConfigPanel />
        </div>
      )}
    </div>
  );
}
