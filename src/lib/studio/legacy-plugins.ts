// Masterkey — Bundle Studio: legacy plugin shim (TEMPORARY). Flow's `@/plugins` was already a no-op stub
// (its static action model was replaced by runtime discovery). The ported workflow-toolbar still references
// three of those no-ops for its LEGACY action-node config paths. Those code paths don't apply to our node
// kinds (purpose/service/instruction/decision/input/output/loop) and are removed when the toolbar is
// adapted in spec §7.4/§7.7 — at which point this file is deleted. Kept now only so the port compiles in
// isolation (§2.4/§2.6).

export type SelectOption = { value: string; label: string };

export type ActionConfigFieldBase = {
  key: string;
  label: string;
  type: "template-input" | "template-textarea" | "text" | "number" | "select" | "schema-builder";
  placeholder?: string;
  defaultValue?: string;
  example?: string;
  options?: SelectOption[];
  rows?: number;
  min?: number;
  max?: number;
  required?: boolean;
  showWhen?: { field: string; equals: string };
};

export type ActionConfigFieldGroup = {
  groupLabel: string;
  label?: string;
  defaultExpanded?: boolean;
  fields: ActionConfigFieldBase[];
};

export type ActionConfigField = ActionConfigFieldBase | ActionConfigFieldGroup;

export type PluginAction = {
  id: string;
  label: string;
  description: string;
  icon?: string;
  integration?: string;
  category?: string;
  configFields: ActionConfigField[];
};

export function findActionById(_actionId: string): PluginAction | undefined {
  return undefined;
}

export function getIntegrationLabels(): Record<string, string> {
  return {};
}

export function flattenConfigFields(fields: ActionConfigField[]): ActionConfigFieldBase[] {
  const result: ActionConfigFieldBase[] = [];
  for (const field of fields) {
    if ("groupLabel" in field) result.push(...field.fields);
    else result.push(field);
  }
  return result;
}
