// Masterkey — Bundle Studio API client (client-side fetch wrapper). Replaces Flow's lib/api-client.ts
// (the file-persistence seam). Same `api.workflow.*` surface the ported canvas/store/toolbar expect, but
// pointed at our auth-gated /api/studio/bundles routes (spec §5). The canvas's working model is
// {id,name,description,nodes,edges}; the §5 API translates that to/from the stored BundleDoc + graph.
//
// NOTE: the /api/studio/bundles routes are implemented in Phase 5. Until then these calls 404 at runtime,
// but the module compiles and the canvas wires against a stable contract (spec §2.4/§2.6 "compile in isolation").

import type { WorkflowEdge, WorkflowNode } from "./workflow-store";

export type WorkflowData = {
  id?: string;
  name?: string;
  description?: string;
  status?: "draft" | "ready"; // PATCH-able (§10.2: a passing E2E test marks the bundle ready)
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
};

export type SavedWorkflow = WorkflowData & {
  id: string;
  name: string;
  slug?: string; // present on the API payload (ApiBundle) — drives the "/" run command + test runs
  createdAt: string;
  updatedAt: string;
};

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
}

async function apiCall<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const response = await fetch(endpoint, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Unknown error" }));
    throw new ApiError(response.status, error.error || "Request failed");
  }
  return response.json();
}

// Bundle (a.k.a. studio "workflow") CRUD — no execution here (running a bundle goes through the durable
// run path via `/`, spec §6/§9). Maps to /api/studio/bundles (§5.1).
export const workflowApi = {
  // GET /api/studio/bundles returns { bundles: [...] } (the library + "/"-menu shape); unwrap to the array
  // the canvas/toolbar expect. (Returning a bare array would break the library page, which reads .bundles.)
  getAll: () => apiCall<{ bundles: SavedWorkflow[] }>("/api/studio/bundles").then((d) => d.bundles ?? []),

  getById: (id: string) => apiCall<SavedWorkflow>(`/api/studio/bundles/${id}`),

  create: (workflow: Omit<WorkflowData, "id">) =>
    apiCall<SavedWorkflow>("/api/studio/bundles", {
      method: "POST",
      body: JSON.stringify(workflow),
    }),

  update: (id: string, workflow: Partial<WorkflowData>) =>
    apiCall<SavedWorkflow>(`/api/studio/bundles/${id}`, {
      method: "PATCH",
      body: JSON.stringify(workflow),
    }),

  delete: (id: string) =>
    apiCall<{ success: boolean }>(`/api/studio/bundles/${id}`, { method: "DELETE" }),

  autoSaveWorkflow: (() => {
    let autosaveTimeout: ReturnType<typeof setTimeout> | null = null;
    const AUTOSAVE_DELAY = 2000;
    return (id: string, data: Partial<WorkflowData>, debounce = true): Promise<SavedWorkflow> | undefined => {
      if (!debounce) return workflowApi.update(id, data);
      if (autosaveTimeout) clearTimeout(autosaveTimeout);
      autosaveTimeout = setTimeout(() => {
        workflowApi.update(id, data).catch((error) => console.error("Auto-save failed:", error));
      }, AUTOSAVE_DELAY);
    };
  })(),
};

export const api = {
  workflow: workflowApi,
};
