"use client";

// Masterkey — shared chrome for a result card (W7): producing-service badge + per-result cost +
// download / save-to-library actions. (RunResult has no domain, so we badge with a modality icon +
// service name rather than a favicon — a serviceId→domain lookup could upgrade this later.)

import type { ReactNode } from "react";
import type { RunOutput, RunResult } from "@/lib/mcp/types";
import { Button } from "@/components/ui/button";
import { Download, Save } from "lucide-react";

function fmtCost(n: number): string {
  if (n <= 0) return "$0.00";
  return `$${n.toFixed(n < 0.01 ? 4 : 2)}`;
}

export function ResultFrame({
  result,
  icon,
  downloadUrl,
  downloadName,
  saveOutput,
  onSave,
  children,
}: {
  result: RunResult;
  icon: ReactNode;
  downloadUrl?: string | null;
  downloadName?: string;
  saveOutput?: RunOutput;
  onSave?: (output: RunOutput) => void;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2 rounded-lg border bg-card p-3">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          {icon}
          <span className="font-medium text-foreground">{result.serviceName}</span>
        </span>
        {result.providerCostUsd != null && <span>{fmtCost(result.providerCostUsd)}</span>}
      </div>

      {children}

      {(downloadUrl || (onSave && saveOutput)) && (
        <div className="flex flex-wrap gap-2 pt-0.5">
          {downloadUrl && (
            <Button asChild variant="outline" size="sm">
              <a href={downloadUrl} download={downloadName} target="_blank" rel="noreferrer">
                <Download className="size-3.5" />
                Download
              </a>
            </Button>
          )}
          {onSave && saveOutput && (
            <Button variant="ghost" size="sm" onClick={() => onSave(saveOutput)}>
              <Save className="size-3.5" />
              Save to library
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
