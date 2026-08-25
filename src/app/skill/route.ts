// GET /skill — the agent-readable "get started forking MasterKey" guide.
// A developer pastes "read and follow masterkey.sh/skill" to their coding agent; the agent WebFetches
// this and walks them through fork → install → env/keys → run → fund wallet. Served as text/markdown
// so agents get clean prose. Source of truth: data/skill/GETTING_STARTED.md (bundled into this route's
// serverless trace via next.config `outputFileTracingIncludes`). A literal `skill/` segment takes
// precedence over the root `[transport]` dynamic route, so /skill resolves here (not to /mcp).
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const dynamic = "force-dynamic";

export async function GET() {
  const md = readFileSync(join(process.cwd(), "data/skill/GETTING_STARTED.md"), "utf8");
  return new Response(md, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
