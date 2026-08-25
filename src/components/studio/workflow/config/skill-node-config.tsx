"use client";

/**
 * Config panel for the new skill node types.
 * Renders form fields appropriate to each node type.
 */

import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  CheckCircle2,
  ChevronLeft,
  FileText,
  GitBranch,
  MessageSquare,
  Plus,
  Sparkles,
  X,
  Zap,
} from "lucide-react";
import { nanoid } from "nanoid";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  changeTypeNodeIdAtom,
  nodesAtom,
  selectedNodeAtom,
  updateNodeDataAtom,
  type WorkflowNode,
  type WorkflowNodeData,
} from "@/lib/studio/workflow-store";
import { ServiceNodeConfig } from "./service-node-config";

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium">{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function TextArea({
  value,
  onChange,
  placeholder,
  rows = 3,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
}) {
  return (
    <textarea
      className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary resize-none"
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      value={value}
    />
  );
}

// ─── Per-type editors ────────────────────────────────────────────────

function PurposeEditor({ node }: { node: WorkflowNode }) {
  const update = useSetAtom(updateNodeDataAtom);
  const d = node.data;

  const set = (fields: Partial<WorkflowNodeData>) =>
    update({ id: node.id, data: fields });

  return (
    <div className="space-y-4">
      <Field label="Skill Name" hint="What is this skill called?">
        <Input
          className="h-9"
          onChange={(e) => set({ name: e.target.value, label: e.target.value })}
          placeholder="e.g. Mail, Recruit, Movie Maker"
          value={d.name || ""}
        />
      </Field>
      <Field label="Description" hint="What does this skill do?">
        <TextArea
          onChange={(v) => set({ description: v })}
          placeholder="e.g. Send physical postcards and letters to friends with AI-generated artwork"
          value={d.description || ""}
        />
      </Field>
      <Field label="Use Cases" hint="When should an agent use this skill?">
        <TextArea
          onChange={(v) => set({ useCases: v })}
          placeholder="e.g. Use when the user asks to send mail, post a letter, send a postcard..."
          value={d.useCases || ""}
        />
      </Field>
      <Field label="What this is NOT for" hint="Optional — explicit boundaries">
        <TextArea
          onChange={(v) => set({ notFor: v })}
          placeholder="e.g. Not for sending emails or digital messages"
          rows={2}
          value={d.notFor || ""}
        />
      </Field>
    </div>
  );
}


// Registry-backed service node config (spec §3.3): embedded endpoint detail + backend selection +
// schema-driven inputMap, sourced from /api/studio/service/[id] — NO live probe/try (D6). The service
// SEARCH/picker is the node palette (§3.4); whole-bundle E2E is the test path (§10).
function ServiceEditor({ node }: { node: WorkflowNode }) {
  return <ServiceNodeConfig node={node} />;
}


function InstructionEditor({ node }: { node: WorkflowNode }) {
  const update = useSetAtom(updateNodeDataAtom);
  const d = node.data;

  const set = (fields: Partial<WorkflowNodeData>) =>
    update({ id: node.id, data: fields });

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Tell the agent what to do at this step — it will follow this autonomously.
      </p>

      <Field label="Label">
        <Input
          className="h-9"
          onChange={(e) => set({ label: e.target.value })}
          placeholder="e.g. Save addresses, Filter results"
          value={d.label || ""}
        />
      </Field>
      <Field label="Instruction" hint="Write in plain English — this becomes a step in the exported skill">
        <TextArea
          onChange={(v) => set({ instruction: v })}
          placeholder={"Write what should happen at this step. Examples:\n\n• If the user has already saved the recipient's address, just ask them to confirm it instead of entering it again\n\n• Always show the generated image before sending. If they don't like it, offer to regenerate\n\n• Convert the scraped content to a clean summary, keeping only the key points"}
          rows={6}
          value={d.instruction || ""}
        />
      </Field>
    </div>
  );
}

// ─── Specialized editors for legacy primitive types ──────────────────

function IfEditor({ node }: { node: WorkflowNode }) {
  const update = useSetAtom(updateNodeDataAtom);
  const d = node.data;
  const set = (fields: Partial<WorkflowNodeData>) => update({ id: node.id, data: fields });

  return (
    <div className="space-y-4">
      <Field label="If..." hint="Describe the condition in plain English">
        <TextArea
          onChange={(v) => set({ instruction: v, label: v.split("\n")[0]?.slice(0, 40) || "If" })}
          placeholder={"e.g. If the user has already saved this recipient's address, just confirm it instead of asking them to enter it again"}
          rows={4}
          value={d.instruction || ""}
        />
      </Field>
      <p className="text-[10px] text-muted-foreground bg-muted/30 rounded-md p-2">
        Connect the <strong>right handle</strong> to the "then" path and the <strong>bottom handle</strong> to the "otherwise" path.
      </p>
    </div>
  );
}

function TransformEditor({ node }: { node: WorkflowNode }) {
  const update = useSetAtom(updateNodeDataAtom);
  const d = node.data;
  const set = (fields: Partial<WorkflowNodeData>) => update({ id: node.id, data: fields });

  const quickPicks = [
    "HTML → Markdown",
    "PDF → Text",
    "JSON → CSV",
    "Extract key points from text",
    "Summarize long content",
    "Format as a table",
  ];

  return (
    <div className="space-y-4">
      <Field label="Convert / Transform" hint="What format or shape should the data become?">
        <TextArea
          onChange={(v) => set({ instruction: v, label: v.split("\n")[0]?.slice(0, 40) || "Transform" })}
          placeholder={"e.g. Convert the scraped HTML content into clean markdown, keeping only headings and paragraphs"}
          rows={3}
          value={d.instruction || ""}
        />
      </Field>
      <div>
        <p className="text-[10px] text-muted-foreground mb-1.5">Quick picks:</p>
        <div className="flex flex-wrap gap-1">
          {quickPicks.map((pick) => (
            <button
              key={pick}
              className="rounded-full border px-2.5 py-1 text-[10px] hover:bg-muted/50 transition-colors"
              onClick={() => set({ instruction: pick, label: pick })}
              type="button"
            >
              {pick}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function DelayEditor({ node }: { node: WorkflowNode }) {
  const update = useSetAtom(updateNodeDataAtom);
  const d = node.data;
  const set = (fields: Partial<WorkflowNodeData>) => update({ id: node.id, data: fields });

  const quickDelays = ["5 seconds", "15 seconds", "30 seconds", "1 minute", "5 minutes"];

  return (
    <div className="space-y-4">
      <Field label="Wait for..." hint="How long to wait, or what to wait for">
        <Input
          className="h-9"
          onChange={(e) => set({ instruction: e.target.value, label: `Wait: ${e.target.value}` })}
          placeholder="e.g. the image to finish generating"
          value={d.instruction || ""}
        />
      </Field>
      <div>
        <p className="text-[10px] text-muted-foreground mb-1.5">Quick picks:</p>
        <div className="flex flex-wrap gap-1">
          {quickDelays.map((delay) => (
            <button
              key={delay}
              className="rounded-full border px-2.5 py-1 text-[10px] hover:bg-muted/50 transition-colors"
              onClick={() => set({ instruction: delay, label: `Wait: ${delay}` })}
              type="button"
            >
              {delay}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function HttpEditor({ node }: { node: WorkflowNode }) {
  const update = useSetAtom(updateNodeDataAtom);
  const d = node.data;
  const set = (fields: Partial<WorkflowNodeData>) => update({ id: node.id, data: fields });

  const quickPicks = [
    { label: "Search the web", value: "Search the web for" },
    { label: "Scrape a webpage", value: "Scrape the content from" },
    { label: "Download a file", value: "Download the file from" },
    { label: "Check a URL", value: "Check if the URL is reachable:" },
  ];

  return (
    <div className="space-y-4">
      <div>
        <p className="text-[10px] text-muted-foreground mb-1.5">What do you need?</p>
        <div className="grid grid-cols-2 gap-1">
          {quickPicks.map((pick) => (
            <button
              key={pick.label}
              className="rounded-lg border px-3 py-2 text-xs text-left hover:bg-muted/50 transition-colors"
              onClick={() => set({ instruction: pick.value, label: pick.label })}
              type="button"
            >
              {pick.label}
            </button>
          ))}
        </div>
      </div>
      <Field label="Details" hint="Describe what to fetch or scrape">
        <TextArea
          onChange={(v) => set({ instruction: v, label: v.split("\n")[0]?.slice(0, 40) || "Web request" })}
          placeholder="e.g. Scrape the content from the given URL and extract the main article text"
          rows={3}
          value={d.instruction || ""}
        />
      </Field>
    </div>
  );
}

function LoopEditor({ node }: { node: WorkflowNode }) {
  const update = useSetAtom(updateNodeDataAtom);
  const allNodes = useAtomValue(nodesAtom);
  const d = node.data;
  const set = (fields: Partial<WorkflowNodeData>) => update({ id: node.id, data: fields });

  // The loop BODY is an explicit set of node ids (§1.1 `bodyNodeIds`). compile.ts maps it to step numbers
  // and renders "Repeat step(s) X–Y for each …"; with an empty body it can only emit the vaguer
  // "Repeat the loop body …", so the brain has no idea which steps to actually repeat.
  const body = d.bodyNodeIds ?? [];
  const toggleBody = (id: string) =>
    set({ bodyNodeIds: body.includes(id) ? body.filter((x) => x !== id) : [...body, id] });
  const candidates = allNodes.filter(
    (n) => n.id !== node.id && !["input", "purpose", "trigger"].includes(n.data.type || ""),
  );

  return (
    <div className="space-y-4">
      <Field label="Label">
        <Input className="h-9" value={d.label || ""} onChange={(e) => set({ label: e.target.value })} placeholder="e.g. For each result" />
      </Field>
      <Field label="For each…" hint="A reference to the collection to iterate, e.g. {{search.results}}">
        <Input
          className="h-9"
          value={d.overRef || ""}
          onChange={(e) => set({ overRef: e.target.value })}
          placeholder="{{nodeId.results}}"
        />
      </Field>
      <Field label="Until (optional)" hint="A plain-English stop condition.">
        <Input
          className="h-9"
          value={d.until || ""}
          onChange={(e) => set({ until: e.target.value })}
          placeholder="e.g. all items processed"
        />
      </Field>
      <Field label="Repeat these steps" hint="The steps that run once per item. Without this the brain is only told to “repeat the loop body”.">
        {candidates.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">Add the steps you want to repeat, then select them here.</p>
        ) : (
          <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-border p-1">
            {candidates.map((n) => {
              const on = body.includes(n.id);
              return (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => toggleBody(n.id)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-muted/60",
                    on && "bg-muted",
                  )}
                >
                  <CheckCircle2 className={cn("size-3.5 shrink-0", on ? "text-primary" : "text-muted-foreground/30")} />
                  <span className="truncate">{n.data.label || n.data.type || "Untitled step"}</span>
                  <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{n.data.type}</span>
                </button>
              );
            })}
          </div>
        )}
      </Field>
      <p className="rounded-md bg-muted/30 p-2 text-[10px] text-muted-foreground">
        v1 loops are rendered to the brain as an explicit “repeat steps … for each …” instruction.
      </p>
    </div>
  );
}

/** Routes legacy node subtypes to their specialized editor */
function LegacyNodeEditor({ node }: { node: WorkflowNode }) {
  const subtype = node.data.subtype || (node.data.config?.subtype as string) || "";

  switch (subtype) {
    case "if":
      return <IfEditor node={node} />;
    case "transform":
      return <TransformEditor node={node} />;
    case "delay":
      return <DelayEditor node={node} />;
    case "http":
      return <HttpEditor node={node} />;
    case "loop":
      return <LoopEditor node={node} />;
    default:
      // Generic instruction for anything else
      return <InstructionEditor node={node} />;
  }
}

function DecisionEditor({ node }: { node: WorkflowNode }) {
  const update = useSetAtom(updateNodeDataAtom);
  const d = node.data;
  const options = d.options || [];

  const set = (fields: Partial<WorkflowNodeData>) =>
    update({ id: node.id, data: fields });

  const addOption = () => {
    set({
      options: [...options, { id: nanoid(6), label: "", description: "" }],
    });
  };

  const removeOption = (id: string) => {
    set({ options: options.filter((o) => o.id !== id) });
  };

  const updateOption = (id: string, fields: Partial<{ label: string; description: string }>) => {
    set({
      options: options.map((o) => (o.id === id ? { ...o, ...fields } : o)),
    });
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        A branching point — the agent picks a path based on the situation.
      </p>

      <Field label="Label">
        <Input
          className="h-9"
          onChange={(e) => set({ label: e.target.value })}
          placeholder="e.g. Mail type?, Role type?"
          value={d.label || ""}
        />
      </Field>
      <Field label="Question" hint="The decision to make — in plain English">
        <TextArea
          onChange={(v) => set({ question: v })}
          placeholder="e.g. What type of mail does the user want to send?"
          rows={2}
          value={d.question || ""}
        />
      </Field>
      <div className="space-y-2">
        <Label className="text-xs font-medium">Options</Label>
        {options.map((opt) => (
          <div key={opt.id} className="flex gap-1.5">
            <Input
              className="h-8 flex-1 text-xs"
              onChange={(e) => updateOption(opt.id, { label: e.target.value })}
              placeholder="Option label (e.g. Letter, Postcard)"
              value={opt.label}
            />
            <Button
              className="h-8 w-8 shrink-0"
              onClick={() => removeOption(opt.id)}
              size="icon"
              variant="ghost"
            >
              <X className="size-3" />
            </Button>
          </div>
        ))}
        <Button
          className="h-8 w-full text-xs"
          onClick={addOption}
          variant="outline"
        >
          <Plus className="size-3 mr-1" /> Add option
        </Button>
      </div>
    </div>
  );
}

function InputEditor({ node }: { node: WorkflowNode }) {
  const update = useSetAtom(updateNodeDataAtom);
  const d = node.data;

  const set = (fields: Partial<WorkflowNodeData>) =>
    update({ id: node.id, data: fields });

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Pauses and asks the user for something — an address, a topic, a file.
      </p>

      <Field label="What to ask for">
        <Input
          className="h-9"
          onChange={(e) => set({ label: e.target.value })}
          placeholder="e.g. Recipient address, Topic, Image to use"
          value={d.label || ""}
        />
      </Field>
      <Field label="How to ask" hint="The question the agent will ask the user">
        <TextArea
          onChange={(v) => set({ prompt: v })}
          placeholder="e.g. Who do you want to send this to? Please provide their full name and mailing address."
          value={d.prompt || ""}
        />
      </Field>
      <Field label="Smart defaults" hint="Help the agent skip this question when possible">
        <TextArea
          onChange={(v) => set({ hints: v })}
          placeholder="e.g. If the user has sent to this person before, use the saved address and just ask them to confirm"
          rows={2}
          value={d.hints || ""}
        />
      </Field>
      <div className="flex items-center justify-between">
        <div>
          <Label className="text-xs">Required</Label>
          <p className="text-xs text-muted-foreground">Must the user answer before continuing?</p>
        </div>
        <Switch
          checked={d.required ?? true}
          onCheckedChange={(v) => set({ required: v })}
        />
      </div>
      <Field label="Remember for next time" hint="Save the answer so the user doesn't have to enter it again">
        <Input
          className="h-8 text-xs font-mono"
          onChange={(e) => set({ saveAs: e.target.value })}
          placeholder="e.g. data/recipient_<name>.md"
          value={d.saveAs || ""}
        />
      </Field>
    </div>
  );
}

function OutputEditor({ node }: { node: WorkflowNode }) {
  const update = useSetAtom(updateNodeDataAtom);
  const d = node.data;

  const set = (fields: Partial<WorkflowNodeData>) =>
    update({ id: node.id, data: fields });

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        What the skill delivers — a report, confirmation, file, or message shown to the user.
      </p>

      <Field label="Label">
        <Input
          className="h-9"
          onChange={(e) => set({ label: e.target.value })}
          placeholder="e.g. Candidate report, Tracking info"
          value={d.label || ""}
        />
      </Field>
      <Field label="Format" hint="What form the output takes">
        <Input
          className="h-9"
          onChange={(e) => set({ format: e.target.value })}
          placeholder="e.g. Markdown report, Confirmation message, JSON data"
          value={d.format || ""}
        />
      </Field>
      <div className="flex items-center justify-between">
        <div>
          <Label className="text-xs">Require confirmation</Label>
          <p className="text-xs text-muted-foreground">Ask user to confirm before finalizing</p>
        </div>
        <Switch
          checked={d.confirm ?? false}
          onCheckedChange={(v) => set({ confirm: v })}
        />
      </div>
      <Field label="Output template" hint="Optional — defines the structure of the output">
        <TextArea
          onChange={(v) => set({ template: v })}
          placeholder={"# Report — {{TITLE}}\n\n## Summary\n{{SUMMARY}}\n\n## Results\n{{RESULTS}}"}
          rows={6}
          value={d.template || ""}
        />
      </Field>
    </div>
  );
}

// ─── Main config component ───────────────────────────────────────────

const NODE_TYPE_INFO: Record<string, { icon: React.ElementType; color: string; label: string }> = {
  purpose: { icon: Sparkles, color: "text-blue-500", label: "Purpose" },
  service: { icon: Zap, color: "text-green-500", label: "Service" },
  instruction: { icon: FileText, color: "text-gray-500", label: "Instruction" },
  decision: { icon: GitBranch, color: "text-amber-500", label: "Decision" },
  input: { icon: MessageSquare, color: "text-purple-500", label: "Input" },
  output: { icon: CheckCircle2, color: "text-teal-500", label: "Output" },
  // Legacy types — map to equivalent new types
  logic: { icon: FileText, color: "text-gray-500", label: "Instruction" },
  data: { icon: FileText, color: "text-gray-500", label: "Instruction" },
  x402: { icon: Zap, color: "text-green-500", label: "Service" },
  action: { icon: FileText, color: "text-gray-500", label: "Instruction" },
  trigger: { icon: Sparkles, color: "text-blue-500", label: "Purpose" },
};

export function SkillNodeConfig() {
  const [selectedNodeId] = useAtom(selectedNodeAtom);
  const nodes = useAtomValue(nodesAtom);
  const update = useSetAtom(updateNodeDataAtom);
  const setChangeTypeNode = useSetAtom(changeTypeNodeIdAtom);

  const selectedNode = nodes.find((n) => n.id === selectedNodeId);

  if (!selectedNode) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 p-6 text-center">
        <Sparkles className="size-8 text-muted-foreground/30" />
        <div>
          <p className="font-medium text-sm">No node selected</p>
          <p className="text-xs text-muted-foreground mt-1">
            Click a node on the canvas to edit it, or use the <strong>+</strong> button to add one.
          </p>
        </div>
      </div>
    );
  }

  const subtype = selectedNode.data.subtype || (selectedNode.data.config?.subtype as string) || "";

  // Subtype-specific labels for legacy nodes
  const SUBTYPE_LABELS: Record<string, string> = {
    if: "Condition",
    transform: "Convert",
    delay: "Wait",
    http: "Web",
    loop: "Repeat",
  };

  const typeInfo = NODE_TYPE_INFO[selectedNode.data.type];
  const displayLabel = SUBTYPE_LABELS[subtype] || typeInfo?.label;

  // Open the node palette to re-type THIS node (replaces the deprecated legacy block picker). The canvas
  // watches changeTypeNodeIdAtom, opens the palette, and applies the chosen kind to this node.
  const handleChangeType = () => {
    setChangeTypeNode(selectedNode.id);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      {typeInfo && (
        <div className="flex items-center border-b px-2 py-2 shrink-0">
          {selectedNode.data.type !== "purpose" && (
            <button
              className="flex items-center gap-0.5 rounded px-1.5 py-1 text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors shrink-0"
              onClick={handleChangeType}
              title="Change type"
              type="button"
            >
              <ChevronLeft className="size-3.5" />
            </button>
          )}
          <div className="flex items-center gap-2 px-1">
            <typeInfo.icon className={cn("size-4", typeInfo.color)} />
            <span className={cn("text-xs font-medium uppercase tracking-wider", typeInfo.color)}>
              {displayLabel}
            </span>
          </div>
        </div>
      )}

      {/* Editor */}
      <div className="flex-1 overflow-y-auto p-4">
        {selectedNode.data.type === "purpose" && <PurposeEditor node={selectedNode} />}
        {selectedNode.data.type === "service" && <ServiceEditor node={selectedNode} />}
        {selectedNode.data.type === "instruction" && <InstructionEditor node={selectedNode} />}
        {selectedNode.data.type === "decision" && <DecisionEditor node={selectedNode} />}
        {selectedNode.data.type === "input" && <InputEditor node={selectedNode} />}
        {selectedNode.data.type === "output" && <OutputEditor node={selectedNode} />}
        {selectedNode.data.type === "loop" && <LoopEditor node={selectedNode} />}

        {/* Legacy types — route to specialized editors based on subtype */}
        {(selectedNode.data.type === "logic" || selectedNode.data.type === "action" || selectedNode.data.type === "data" || selectedNode.data.type === "trigger") && (
          <LegacyNodeEditor node={selectedNode} />
        )}

        {selectedNode.data.type === "x402" && <ServiceEditor node={selectedNode} />}

        {/* Fallback */}
        {!typeInfo && (
          <div className="py-4 text-center text-xs text-muted-foreground">
            This node type does not have a config editor yet.
          </div>
        )}
      </div>

    </div>
  );
}
