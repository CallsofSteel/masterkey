import { defineConfig } from "@trigger.dev/sdk";
import { additionalFiles } from "@trigger.dev/build/extensions/core";

// Set TRIGGER_PROJECT_REF to your own Trigger.dev project ref (proj_…).
export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF || "proj_your_project_ref",
  dirs: ["./src/trigger"],
  maxDuration: 3600, // seconds; per-task timeout.None overrides for long-paused runs
  // Retries on in dev too (matches prod) so a crashed/killed worker re-attempts the run — the durable
  // resume path. The MCP run_idempotency record is what makes a re-attempt safe (no double-charge).
  retries: {
    enabledInDev: true,
    default: { maxAttempts: 3, minTimeoutInMs: 1000, maxTimeoutInMs: 10000, factor: 2, randomize: true },
  },
  // The Trigger task reads the server-only registry IN-PROCESS via findServiceById (seed-prompt.ts +
  // approval-rules.ts → getIndex → readFileSync(data/registry/index.json)). The deploy container's cwd
  // is /app, so without bundling these the task throws `ENOENT /app/data/registry/index.json` (seeded
  // runs failed before turn 0). additionalFiles copies them preserving the project-relative path →
  // /app/data/registry/**. (Vercel's /mcp route gets them separately via next.config outputFileTracing.)
  build: {
    extensions: [additionalFiles({ files: ["./data/registry/**/*.json", "./data/bundles/**/*.json"] })],
  },
});
