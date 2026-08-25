"use client";

import { useState, useMemo, useRef, useEffect } from "react";
import { Composer } from "@/components/run/Composer";
import {
  Search,
  X,
  LayoutGrid,
  List,
  Image as ImageIcon,
  Server,
  MessageSquare,
  BarChart3,
  Bot,
  Brain,
  ShieldCheck,
  CreditCard,
  Database,
  Wrench,
  SearchCode,
  FileText,
  Film,
  Calendar,
  PieChart,
  ShoppingCart,
  Lock,
  ClipboardList,
  MapPin,
  ChevronRight,
  ExternalLink,
  Copy,
  Check,
  Sparkles,
  CheckSquare,
  Square,
  type LucideIcon,
} from "lucide-react";
import type {
  RegistryIndex,
  EntrySummary,
  Service,
  Backend,
  Operation,
} from "@/data/types";
import { backendKeys, indexForBackendKey } from "@/data/backend-key";
import localLogos from "@/data/logos.json";
import { cn } from "@/lib/utils";
import { AccountMenu } from "./account-menu";
import { IntroReplayEgg } from "@/components/intro-replay-egg";
import { LogoThemeToggle } from "@/components/logo-theme-toggle";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { BundleBar } from "@/components/bundle/BundleBar";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarSeparator,
  SidebarTrigger,
} from "@/components/ui/sidebar";

const ALL_SLUG = "__all__";

// Curated umbrella tabs for the search-first All view — each maps to a set of our real categories.
const GROUPS: { key: string; label: string; cats: string[] }[] = [
  { key: "all", label: "All", cats: [] },
  { key: "ai", label: "AI & ML", cats: ["ai-ml"] },
  { key: "media", label: "Media", cats: ["media", "image-video-processing"] },
  { key: "data", label: "Data & Search", cats: ["data-intelligence", "search", "web-automation", "maps-location"] },
  { key: "dev", label: "Dev & Infra", cats: ["devtools-observability", "infrastructure", "database-storage", "document-content"] },
  { key: "comms", label: "Communication", cats: ["communication"] },
  { key: "pay", label: "Payments & Commerce", cats: ["payments-billing", "ecommerce"] },
  { key: "ops", label: "Security & Ops", cats: ["auth-identity", "security", "analytics-bi", "scheduling-calendars", "forms-surveys"] },
];

const searchAliases: Record<string, string[]> = {
  "voice to text": ["speech-to-text", "stt", "transcription", "whisper", "deepgram"],
  "text to speech": ["voice-tts", "tts", "elevenlabs", "text-to-speech"],
  "image gen": ["image-generation", "dall-e", "flux", "nano banana"],
  "video gen": ["video-generation", "runway", "kling", "sora", "veo"],
  "music gen": ["music-generation", "suno", "udio"],
  db: ["database", "database-storage", "postgres", "supabase", "neon", "turso"],
  llm: ["llm-chat-apis", "openai", "anthropic", "claude", "gemini"],
  ai: ["ai-ml", "llm", "inference"],
  ocr: ["ocr-document-extraction", "document extraction", "reducto"],
  email: ["email", "resend", "sendgrid", "agentmail"],
  sms: ["sms-phone", "twilio", "textbelt", "agentphone"],
  payments: ["payment-processing", "stripe", "laso"],
  crypto: ["crypto-blockchain-data", "crypto-web3-payments", "coinmarketcap"],
  storage: ["object-file-storage", "decentralized-ipfs", "pinata", "walrus"],
  vector: ["vector-databases", "memoryapi", "embeddings"],
  scraping: ["web-scraping", "firecrawl", "exa"],
  maps: ["maps-geolocation", "mapbox", "google maps", "geocoding"],
  phone: ["sms-phone", "video-voice-calls", "stablephone", "agentphone"],
};

// --- fuzzy, relevance-ranked search ---------------------------------------
// Tokenized matching with light stemming (shared-prefix), so "background remover"
// matches "Background Removal" and natural-language queries work ("remove the image background").
const STOP = new Set([
  "i", "want", "to", "the", "of", "a", "an", "my", "is", "are", "for", "use", "using",
  "with", "via", "on", "please", "me", "you", "that", "this", "and", "need", "get", "do", "from", "any",
]);

function tokenize(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}
function sharedPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}
// A query token "hits" a field word if equal, a prefix either way, or shares a 4+ char stem
// (handles removal≈remover, transcription≈transcribe, generate≈generation).
function tokenHits(qt: string, words: string[]): boolean {
  for (const w of words) {
    if (w === qt) return true;
    if (w.length >= 3 && qt.length >= 3 && (w.startsWith(qt) || qt.startsWith(w))) return true;
    if (sharedPrefix(w, qt) >= 4) return true;
  }
  return false;
}
function aliasExpansions(q: string): string[] {
  const out: string[] = [];
  for (const [alias, exp] of Object.entries(searchAliases)) if (q.includes(alias)) out.push(...exp);
  return out;
}
// 0 = no match; higher = more relevant. Empty query → 1 (everything passes).
function searchScore(e: EntrySummary, query: string): number {
  const q = query.toLowerCase().trim();
  if (!q) return 1;
  const qTokens = tokenize(q).filter((t) => !STOP.has(t));
  if (qTokens.length === 0) return 1;
  const fields: [string, number][] = [
    [e.name, 10],
    [e.provider, 5],
    [e.tags.join(" "), 4],
    [e.subcategory.replace(/-/g, " "), 3],
    [e.category.replace(/-/g, " "), 2],
    [e.description ?? "", 2],
  ];
  const fieldWords: [string[], number][] = fields.map(([t, w]) => [tokenize(t), w]);
  let score = 0;
  let allMatched = true;
  for (const qt of qTokens) {
    let best = 0;
    for (const [words, w] of fieldWords) if (tokenHits(qt, words)) best = Math.max(best, w);
    if (best === 0) allMatched = false;
    score += best;
  }
  let result = allMatched ? score : 0; // AND across query tokens
  const ax = aliasExpansions(q);
  if (ax.length) {
    const blob = fields.map(([t]) => t).join(" ").toLowerCase();
    if (ax.some((a) => blob.includes(a))) result = Math.max(result, 6); // alias/synonym recall
  }
  if (q.length >= 3 && e.name.toLowerCase().includes(q)) result += 50; // exact name phrase wins (skip 2-char substrings like "db" in "sandbox")
  return result;
}
// Score, drop non-matches, sort by relevance (stable for empty query → registry order).
function rank(list: EntrySummary[], query: string): EntrySummary[] {
  if (!query.trim()) return list;
  return list
    .map((e) => ({ e, s: searchScore(e, query) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.e);
}

const categoryIcons: Record<string, LucideIcon> = {
  [ALL_SLUG]: LayoutGrid,
  media: ImageIcon,
  infrastructure: Server,
  communication: MessageSquare,
  "data-intelligence": BarChart3,
  "web-automation": Bot,
  "ai-ml": Brain,
  "auth-identity": ShieldCheck,
  "payments-billing": CreditCard,
  "database-storage": Database,
  "devtools-observability": Wrench,
  search: SearchCode,
  "document-content": FileText,
  "image-video-processing": Film,
  "scheduling-calendars": Calendar,
  "analytics-bi": PieChart,
  ecommerce: ShoppingCart,
  security: Lock,
  "forms-surveys": ClipboardList,
  "maps-location": MapPin,
};

// Initials fallback (muted style) for services without a logo.
function Avatar({ name, size = 16 }: { name: string; size?: number }) {
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-sm bg-muted font-medium text-muted-foreground"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.6) }}
      aria-hidden
    >
      {(name[0] || "?").toUpperCase()}
    </span>
  );
}

// Brand logo — checks local /logos/ first, falls back to DuckDuckGo favicon service.
function Favicon({
  domain,
  name,
  size = 16,
}: {
  domain?: string | null;
  name: string;
  size?: number;
}) {
  const logos = localLogos as Record<string, string>;
  const localExt = domain ? logos[domain] : undefined;
  const localSrc = localExt ? `/logos/${domain}.${localExt}` : null;
  const ddgSrc = domain ? `https://icons.duckduckgo.com/ip3/${domain}.ico` : null;

  const [src, setSrc] = useState<string | null>(localSrc ?? ddgSrc);
  const tried = useRef({ local: !!localSrc, ddg: !localSrc && !!ddgSrc });

  if (!domain || !src) return <Avatar name={name} size={size} />;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      className="shrink-0 rounded-sm"
      onError={() => {
        if (tried.current.local && ddgSrc && src !== ddgSrc) {
          tried.current.ddg = true;
          setSrc(ddgSrc);
        } else {
          setSrc(null);
        }
      }}
    />
  );
}

function PricePill({ display }: { display: string }) {
  const free = /free/i.test(display);
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums",
        free ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-secondary text-secondary-foreground"
      )}
    >
      {display}
    </span>
  );
}

// Card (used in per-category grid view).
function EntryCard({ entry, onOpen }: { entry: EntrySummary; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className="group relative flex flex-col gap-1 rounded-lg border border-border bg-card p-3 text-left transition-all hover:border-ring hover:bg-accent cursor-pointer"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Favicon domain={entry.domain} name={entry.name} />
          <span className="truncate text-sm font-medium leading-tight text-foreground">{entry.name}</span>
        </div>
        <PricePill display={entry.price.display} />
      </div>
      {entry.description && (
        <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">{entry.description}</p>
      )}
      <span className="mt-auto truncate pt-1 text-xs text-primary/70 transition-colors group-hover:text-primary">
        {entry.domain || entry.provider}
      </span>
    </button>
  );
}

// Single row (search-first List view). In selection mode the row toggles selection (checkbox) instead
// of opening the detail sheet.
function ListRow({
  entry,
  onOpen,
  selectMode,
  selected,
}: {
  entry: EntrySummary;
  onOpen: () => void;
  selectMode?: boolean;
  selected?: boolean;
}) {
  return (
    <button
      onClick={onOpen}
      aria-pressed={selectMode ? !!selected : undefined}
      className={cn(
        "group flex w-full items-center gap-3 rounded-lg border bg-card px-3 py-2.5 text-left transition-colors hover:border-ring hover:bg-accent cursor-pointer",
        selectMode && selected ? "border-primary ring-1 ring-primary" : "border-border",
      )}
    >
      {selectMode &&
        (selected ? (
          <CheckSquare className="h-5 w-5 shrink-0 text-primary" />
        ) : (
          <Square className="h-5 w-5 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-foreground" />
        ))}
      <Favicon domain={entry.domain} name={entry.name} size={22} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{entry.name}</span>
          <span className="hidden truncate text-xs text-muted-foreground sm:block">{entry.provider}</span>
        </div>
        {entry.description && <p className="truncate text-xs text-muted-foreground">{entry.description}</p>}
      </div>
      <PricePill display={entry.price.display} />
      {!selectMode && (
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-foreground" />
      )}
    </button>
  );
}

// Live column count matched to the Tailwind breakpoints used below (sm/lg/xl).
function useColumns(): number {
  const [cols, setCols] = useState(4); // SSR + first paint default; corrected on mount
  useEffect(() => {
    const calc = () => {
      const w = window.innerWidth;
      setCols(w < 640 ? 1 : w < 1024 ? 2 : w < 1280 ? 3 : 4);
    };
    calc();
    window.addEventListener("resize", calc);
    return () => window.removeEventListener("resize", calc);
  }, []);
  return cols;
}

// Greedy balance: drop each block into the currently-shortest column. Unlike CSS
// column-balancing this always uses every column, so sparse views still fill the width.
function distribute<T extends { length: number }>(blocks: [string, T][], cols: number): [string, T][][] {
  const columns: [string, T][][] = Array.from({ length: cols }, () => []);
  const heights = new Array(cols).fill(0);
  for (const b of blocks) {
    let min = 0;
    for (let i = 1; i < cols; i++) if (heights[i] < heights[min]) min = i;
    columns[min].push(b);
    heights[min] += 1.6 + b[1].length; // ~1.6 lines for the header + one line per service
  }
  return columns;
}

// Dense masonry "complete overview" (category → subcategory → compact rows).
function Overview({
  items,
  catOrder,
  catName,
  subName,
  onOpen,
  selectMode,
  selectedIds,
}: {
  items: EntrySummary[];
  catOrder: string[];
  catName: Record<string, string>;
  subName: Record<string, string>;
  onOpen: (e: EntrySummary) => void;
  selectMode?: boolean;
  selectedIds?: Set<string>;
}) {
  const byCat = new Map<string, Map<string, EntrySummary[]>>();
  for (const e of items) {
    if (!byCat.has(e.category)) byCat.set(e.category, new Map());
    const subs = byCat.get(e.category)!;
    if (!subs.has(e.subcategory)) subs.set(e.subcategory, []);
    subs.get(e.subcategory)!.push(e);
  }
  const cats = catOrder.filter((c) => byCat.has(c));
  const columns = useColumns();

  const rows = (es: EntrySummary[]) => (
    <div className="flex flex-col">
      {es.map((e) => {
        const sel = selectMode && selectedIds?.has(e.id);
        return (
          <button
            key={`${e.subcategory}:${e.id}`}
            onClick={() => onOpen(e)}
            aria-pressed={selectMode ? !!sel : undefined}
            className="group flex items-center gap-2 py-0.5 text-left cursor-pointer"
          >
            {selectMode &&
              (sel ? (
                <CheckSquare className="h-3.5 w-3.5 shrink-0 text-primary" />
              ) : (
                <Square className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-foreground" />
              ))}
            <Favicon domain={e.domain} name={e.name} size={16} />
            <span
              className={cn(
                "truncate text-sm transition-colors group-hover:text-primary",
                sel ? "font-medium text-primary" : "text-foreground",
              )}
            >
              {e.name}
            </span>
          </button>
        );
      })}
    </div>
  );

  // Few categories (an umbrella tab like "Media"): drop the category/umbrella headers and
  // greedily balance every SUBCATEGORY block (e.g. "Background Removal") across all columns,
  // so even sparse views fill the full width.
  if (cats.length <= 6) {
    const subBlocks: [string, EntrySummary[]][] = [];
    for (const c of cats) for (const entry of byCat.get(c)!.entries()) subBlocks.push(entry);
    return (
      <div className="flex items-start gap-6">
        {distribute(subBlocks, columns).map((col, i) => (
          <div key={i} className="flex min-w-0 flex-1 flex-col gap-5">
            {col.map(([sub, es]) => (
              <div key={sub}>
                <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {subName[sub] ?? sub}
                </h3>
                {rows(es)}
              </div>
            ))}
          </div>
        ))}
      </div>
    );
  }

  // Many categories (the full "All" tab): pack each category as one masonry block.
  return (
    <div className="columns-1 gap-6 sm:columns-2 lg:columns-3 xl:columns-4 [column-fill:balance]">
      {cats.map((c) => (
        <div key={c} className="mb-6 inline-block w-full break-inside-avoid">
          <h2 className="mb-2 font-heading text-lg font-normal italic text-foreground">{catName[c] ?? c}</h2>
          {[...byCat.get(c)!.entries()].map(([sub, es]) => (
            <div key={sub} className="mb-3">
              <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {subName[sub] ?? sub}
              </h3>
              {rows(es)}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function Schema({ label, schema }: { label: string; schema: Record<string, unknown> | null | undefined }) {
  if (!schema || Object.keys(schema).length === 0) return null;
  return (
    <details className="mt-1.5">
      <summary className="cursor-pointer text-[11px] text-muted-foreground hover:text-foreground">{label}</summary>
      <pre className="mt-1 max-h-56 overflow-auto rounded-md bg-muted p-2 text-[10px] leading-relaxed text-foreground">
        {JSON.stringify(schema, null, 2)}
      </pre>
    </details>
  );
}

// The operation a backend performs, derived from its URL's last path segment (generate/edit/upscale/…).
// Same-model services often ship several (e.g. StableStudio …/generate AND …/edit) — surfacing this lets
// the user tell them apart when picking a provider.
function endpointOp(url: string): string {
  try {
    const seg = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
    return /^(generate|edit|upscale|variations?|inpaint|outpaint|describe|caption|remove-bg|background-removal|enhance|restore)$/i.test(
      seg,
    )
      ? seg.toLowerCase()
      : "";
  } catch {
    return "";
  }
}

// A normalized callable endpoint — one row shape for BOTH a Backend (model-kind: a provider serving the
// model) and an Operation (api-kind: a distinct action). The two carry near-identical fields (url/method/
// price/payment/schemas), so rendering them through ONE component means a `kind:"api"` service's operations
// can never again be silently dropped because only the backends path was updated (the "0 backends" bug).
type CallableEndpoint = {
  label: string; // provider name (backend) or operation name (op)
  tag?: string; // variant chip: generate/edit for a backend; ops name themselves via `label`
  method: string;
  url: string;
  priceDisplay?: string;
  protocols: string[];
  networks: string[];
  needsReview?: boolean;
  inputSchema?: Record<string, unknown> | null;
  outputSchema?: Record<string, unknown> | null;
};

function backendToEndpoint(b: Backend): CallableEndpoint {
  const accepts = b.payment?.accepts ?? [];
  return {
    label: b.provider,
    tag: endpointOp(b.url) || undefined,
    method: b.method,
    url: b.url,
    priceDisplay: b.price?.display,
    protocols: b.payment?.protocols ?? [],
    networks: [...new Set(accepts.map((a) => a.network).filter(Boolean))],
    needsReview: b.status === "needs-review",
    inputSchema: b.inputSchema,
    outputSchema: b.outputSchema,
  };
}

function operationToEndpoint(o: Operation): CallableEndpoint {
  const accepts = o.payment?.accepts ?? [];
  return {
    label: o.name,
    method: o.method,
    url: o.url,
    priceDisplay: o.price?.display,
    protocols: o.payment?.protocols ?? [],
    networks: [...new Set(accepts.map((a) => a.network).filter(Boolean))],
    // Operation.status is only "active" | "hidden" (no needs-review), so this chip never applies to ops.
    inputSchema: o.inputSchema,
    outputSchema: o.outputSchema,
  };
}

function EndpointRow({
  endpoint,
  selectable,
  selected,
  onSelect,
}: {
  endpoint: CallableEndpoint;
  selectable?: boolean;
  selected?: boolean;
  onSelect?: () => void;
}) {
  const { label, tag, method, url, priceDisplay, protocols, networks, needsReview, inputSchema, outputSchema } =
    endpoint;
  return (
    <div
      onClick={selectable ? onSelect : undefined}
      role={selectable ? "radio" : undefined}
      aria-checked={selectable ? !!selected : undefined}
      className={cn(
        "rounded-lg border p-3",
        selectable && "cursor-pointer hover:border-primary/60",
        selected ? "border-primary ring-1 ring-primary" : "border-border",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-medium text-foreground">
          {selectable && (
            <span
              className={cn(
                "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border",
                selected ? "border-primary" : "border-muted-foreground/40",
              )}
            >
              {selected && <span className="h-1.5 w-1.5 rounded-full bg-primary" />}
            </span>
          )}
          {label}
          {tag && (
            <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-secondary-foreground">
              {tag}
            </span>
          )}
        </span>
        <PricePill display={priceDisplay ?? "Varies"} />
      </div>
      <div className="mt-1 flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
        <span className="rounded bg-secondary px-1 py-0.5 text-secondary-foreground">{method}</span>
        <span className="truncate">{url}</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-1 text-[10px]">
        {protocols.map((p) => (
          <span key={p} className="rounded bg-primary/10 px-1.5 py-0.5 text-primary">{p}</span>
        ))}
        {networks.map((n) => (
          <span key={n} className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">{n}</span>
        ))}
        {needsReview && (
          <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-amber-600 dark:text-amber-400">needs-review</span>
        )}
      </div>
      <Schema label="input schema" schema={inputSchema} />
      <Schema label="output schema" schema={outputSchema} />
    </div>
  );
}

// A backend is runnable only if the server can pay it: active + x402 + at least one network in accepts.
// Mirrors the MCP's targetsFor(active) + isPayable gate — a backend with empty accepts yields
// `no_payable_target` at run time, so we must NOT offer it as a selectable choice.
function isPayableBackend(b: Backend): boolean {
  return (
    b.status === "active" &&
    (b.payment?.protocols ?? []).includes("x402") &&
    (b.payment?.accepts ?? []).some((a) => !!a.network)
  );
}

// An operation is runnable only if the server can pay it — same gate as isPayableBackend, mirroring the
// MCP's targetsFor()+isPayable so a `kind:"api"` service's callable actions are surfaced consistently.
function isPayableOperation(o: Operation): boolean {
  return (
    (o.status ?? "active") !== "hidden" &&
    (o.payment?.protocols ?? []).includes("x402") &&
    (o.payment?.accepts ?? []).some((a) => !!a.network)
  );
}

// The representative operation to seed the "Prompt for AI" with a concrete endpoint+schema (api-kind
// services expose N distinct actions, not substitutable providers — the prompt then lists all of them).
function primaryOperation(ops: Operation[]): Operation | null {
  if (!ops.length) return null;
  return ops.find(isPayableOperation) ?? ops[0];
}

// Pick the default backend: among PAYABLE backends prefer the headline price, else the first priced,
// else the first payable; fall back to any backend only if none are payable. Returns its index in
// s.backends (so it maps to a stable selector key).
function primaryBackendIndex(s: Service): number {
  const bs = s.backends ?? [];
  if (!bs.length) return -1;
  const pool = bs.some(isPayableBackend) ? bs.filter(isPayableBackend) : bs;
  let pick = s.pricing.amount != null ? pool.find((b) => b.price?.amount === s.pricing.amount) : undefined;
  pick ??= pool.find((b) => b.price?.amount != null) ?? pool[0];
  return bs.indexOf(pick);
}

// Build the AI-ready prompt to copy + take away — reflects the user's selected endpoint (a picked backend
// for model-kind, or the representative operation for api-kind). This is the ONLY surface carrying the
// registry's `usage` guide + quirks: they're call-time detail, so they belong with the thing making the
// call rather than in a card the human has to read past. `opNames` (api-kind) lists the other actions.
function buildPrompt(s: Service, ep: CallableEndpoint | null, opNames?: string[]): string {
  const firstSentence = (s.description || "").split(/(?<=[.!?])\s/)[0].replace(/[.!?]+$/, "").trim();
  // Splice the description into "…service to <task>." by lowercasing its first letter — but leave an
  // opening acronym intact, else "OCR and parse a PDF" reads as "oCR and parse a PDF".
  const firstWord = firstSentence.split(/\s+/)[0] ?? "";
  const opensWithAcronym = firstWord.length > 1 && firstWord === firstWord.toUpperCase();
  const task = firstSentence
    ? opensWithAcronym
      ? firstSentence
      : firstSentence.charAt(0).toLowerCase() + firstSentence.slice(1)
    : `use ${s.name}`;
  const by = s.provider && s.provider !== "Various" ? ` by ${s.provider}` : "";
  const lines: string[] = [`I want to use the "${s.name}" service${by} to ${task}.`, ""];
  if (ep) {
    const protos = (ep.protocols.length ? ep.protocols : ["x402"]).join("/");
    const nets = ep.networks;
    lines.push(`Endpoint: ${ep.method} ${ep.url}`);
    lines.push(`Price: ${ep.priceDisplay ?? s.pricing.headline} ${s.pricing.unit} — pay-per-use via ${protos}${nets.length ? ` on ${nets.join(", ")}` : ""}.`);
    lines.push(`Input schema: ${ep.inputSchema ? JSON.stringify(ep.inputSchema) : "(not published — pass the inputs the task requires)"}`);
    lines.push(`Output schema: ${ep.outputSchema ? JSON.stringify(ep.outputSchema) : "(not published)"}`);
  } else {
    lines.push(`Pricing: ${s.pricing.headline} ${s.pricing.unit}.`);
  }
  // api-kind services expose several distinct actions; name them so the caller picks the right one (the
  // Endpoint line above shows one representative operation with its concrete schema).
  if (opNames && opNames.length > 1) {
    lines.push("", `This service offers ${opNames.length} operations: ${opNames.join(", ")}. Pick the one that fits the task.`);
  }
  // Registry QA's tested call guide + gotchas. "How to use:" matches the label the run brain already
  // uses (`src/lib/agent/seed-prompt.ts`), so a pasted prompt reads the same as a seeded run.
  if (s.usage?.guide) lines.push("", `How to use: ${s.usage.guide}`);
  if (s.usage?.quirks?.length) {
    lines.push("", "Important quirks — read before calling:");
    for (const q of s.usage.quirks) lines.push(`- ${q}`);
  }
  lines.push("", "I'll provide the input next — call the endpoint over x402 and return the result.");
  return lines.join("\n");
}

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard?.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-accent cursor-pointer"
    >
      {copied ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
      {copied ? "Copied" : label}
    </button>
  );
}

function DetailBody({ service }: { service: Service }) {
  const [advanced, setAdvanced] = useState(false);
  const backends = useMemo(() => service.backends ?? [], [service]);
  // api-kind services carry their callable endpoints in operations[] (not backends[]). Mirror the served
  // view: registry.ts already strips hidden ops; also drop internal (cron/webhook/admin) actions.
  const operations = useMemo(
    () => (service.operations ?? []).filter((o) => o.status !== "hidden" && o.audience !== "internal"),
    [service],
  );
  const entries = useMemo(() => backends.map((b) => ({ providerId: b.providerId, url: b.url })), [backends]);
  const keys = useMemo(() => backendKeys(entries), [entries]);
  const defaultKey = keys[primaryBackendIndex(service)] ?? "";
  // The user's picked provider/endpoint (defaults to the cheapest/headline backend). selIndex always
  // resolves — a stale key from a previously-open service falls back to the default, never breaks.
  const [selKey, setSelKey] = useState(defaultKey);
  const ki = indexForBackendKey(entries, selKey);
  const selIndex = ki >= 0 ? ki : primaryBackendIndex(service);
  const selectedBackend = backends[selIndex] ?? null;
  const selKeyEffective = keys[selIndex] || undefined;
  const payableCount = backends.filter(isPayableBackend).length;
  const canPick = payableCount > 1;
  // The endpoint that seeds the "Prompt for AI": the picked backend (model-kind) or the representative
  // operation (api-kind). endpointCount/endpointNoun drive the Advanced header label for both shapes.
  const primaryOp = backends.length ? null : primaryOperation(operations);
  const selectedEndpoint = selectedBackend
    ? backendToEndpoint(selectedBackend)
    : primaryOp
    ? operationToEndpoint(primaryOp)
    : null;
  const prompt = buildPrompt(service, selectedEndpoint, backends.length ? undefined : operations.map((o) => o.name));
  const endpointCount = backends.length || operations.length;
  const endpointNoun = backends.length ? "backend" : "operation";
  return (
    <div className="space-y-4">
      <p className="text-sm leading-relaxed text-foreground">{service.description}</p>
      <div className="flex flex-wrap items-center gap-2">
        <PricePill display={service.pricing.headline} />
        <span className="text-xs text-muted-foreground">{service.pricing.unit}</span>
        {service.modality && (
          <span className="text-xs text-muted-foreground">
            · {service.modality.input.join("+")} → {service.modality.output.join("+")}
          </span>
        )}
      </div>
      {service.tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {service.tags.map((t) => (
            <span key={t} className="rounded-md bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{t}</span>
          ))}
        </div>
      )}

      {/* NOTE: the usage guide + quirks are deliberately NOT rendered as their own "How to use" card.
          They're operator detail for whoever CALLS the endpoint, not something a browsing human acts on,
          and the raw guide is long enough to dominate the sheet. buildPrompt() folds them into the
          "Prompt for AI" block instead, so the Registry QA moat still reaches the thing making the call. */}

      {/* Run it — seeded compose-to-run (W2). The picked provider/endpoint is carried into the run. */}
      <div className="rounded-lg border border-border bg-card p-3">
        <div className="mb-2 flex items-center gap-1.5 text-sm font-medium text-foreground">
          <Sparkles className="h-3.5 w-3.5 text-primary" /> Use it
        </div>
        {canPick && selectedBackend && (
          <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
            <span>
              Provider: <span className="font-medium text-foreground">{selectedBackend.provider}</span>
              {selectedBackend.price?.display ? ` · ${selectedBackend.price.display}` : ""}
            </span>
            <button onClick={() => setAdvanced(true)} className="cursor-pointer text-primary hover:underline">
              change
            </button>
          </div>
        )}
        <Composer seedServiceId={service.id} seedServiceName={service.name} seedBackendProviderId={selKeyEffective} />
      </div>

      {/* AI-ready prompt — the seam for the upcoming chat component (secondary affordance). */}
      <div className="rounded-lg border border-border bg-accent/40 p-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
            <Sparkles className="h-3.5 w-3.5 text-primary" /> Prompt for AI
          </span>
          <CopyButton text={prompt} label="Copy prompt" />
        </div>
        <pre className="whitespace-pre-wrap break-words font-sans text-[11px] leading-relaxed text-muted-foreground">
          {prompt}
        </pre>
        <p className="mt-2 text-[10px] text-muted-foreground">
          Send this to the chat assistant (coming soon) and it will call the endpoint for you over x402.
        </p>
      </div>

      <div className="rounded-lg border border-border">
        <button
          onClick={() => setAdvanced((v) => !v)}
          className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left cursor-pointer"
        >
          <span className="text-sm font-medium">
            Advanced (technical) · {endpointCount} {endpointNoun}{endpointCount === 1 ? "" : "s"}
          </span>
          <ChevronRight className={cn("h-4 w-4 transition-transform", advanced && "rotate-90")} />
        </button>
        {advanced && (
          <div className="space-y-2 border-t border-border p-3">
            {service.usage?.callShape && (
              <div className="rounded-md bg-muted/50 p-2">
                <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Call shape</div>
                <code className="block break-words text-[11px] text-foreground">{service.usage.callShape}</code>
                {service.usage.inputExample && Object.keys(service.usage.inputExample).length > 0 && (
                  <pre className="mt-1 overflow-x-auto rounded bg-background p-2 text-[10px] leading-relaxed text-muted-foreground">
                    {JSON.stringify(service.usage.inputExample, null, 2)}
                  </pre>
                )}
                {service.usage.outputShape && (
                  <p className="mt-1 text-[10px] text-muted-foreground"><span className="font-medium">Returns:</span> {service.usage.outputShape}</p>
                )}
              </div>
            )}
            {canPick && (
              <p className="text-[11px] text-muted-foreground">
                Pick the provider/endpoint to use — the chat and the copied prompt will use your choice.
              </p>
            )}
            {backends.length > 0
              ? backends.map((b, i) => (
                  <EndpointRow
                    key={`${b.url}-${i}`}
                    endpoint={backendToEndpoint(b)}
                    selectable={canPick && isPayableBackend(b)}
                    selected={canPick && i === selIndex}
                    onSelect={() => setSelKey(keys[i])}
                  />
                ))
              : operations.map((o, i) => (
                  // api-kind: distinct actions, not substitutable providers → shown, not selectable.
                  <EndpointRow key={`${o.url}-${i}`} endpoint={operationToEndpoint(o)} />
                ))}
            {service.docs?.openapi && (
              <a
                href={service.docs.openapi}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
              >
                <ExternalLink className="h-3 w-3" /> OpenAPI spec
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// Deterministic UTC date format (avoids server/client locale hydration mismatch).
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function formatSynced(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

export default function Catalog({ index }: { index: RegistryIndex }) {
  const { categories, entries } = index;
  const lastSynced = formatSynced(index.syncedAt);

  const [view, setView] = useState(ALL_SLUG); // ALL_SLUG or a category slug
  const [query, setQuery] = useState("");
  const [allGroup, setAllGroup] = useState("all"); // umbrella tab key
  const [allMode, setAllMode] = useState<"list" | "overview">("overview");
  const [sidebarOpen, setSidebarOpen] = useState(false); // hidden on the All view by default
  const [openEntry, setOpenEntry] = useState<EntrySummary | null>(null);
  const [detail, setDetail] = useState<Service | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const cache = useRef(new Map<string, Service[]>());

  // Bundle Creator (All-view only): photo-library-style multi-select. `selected` keeps full summaries
  // (in pick order) so the bar can show names; persists across umbrella tabs + search.
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<EntrySummary[]>([]);
  const selectedIds = useMemo(() => new Set(selected.map((s) => s.id)), [selected]);
  const toggleSelect = (entry: EntrySummary) =>
    setSelected((prev) =>
      prev.some((s) => s.id === entry.id) ? prev.filter((s) => s.id !== entry.id) : [...prev, entry],
    );
  const removeSelect = (id: string) => setSelected((prev) => prev.filter((s) => s.id !== id));
  // Lift registry-proposed additions (from the skill brain's needs_confirmation flow) into the selection.
  const addSelect = (addIds: string[]) =>
    setSelected((prev) => {
      const have = new Set(prev.map((s) => s.id));
      const adds = addIds
        .filter((id) => !have.has(id))
        .map((id) => entries.find((e) => e.id === id))
        .filter((e): e is EntrySummary => !!e);
      return adds.length ? [...prev, ...adds] : prev;
    });
  const exitSelect = () => {
    setSelectMode(false);
    setSelected([]);
  };

  const isAll = view === ALL_SLUG;
  const total = entries.length;
  const catOrder = useMemo(() => categories.map((c) => c.slug), [categories]);
  const catName = useMemo(() => Object.fromEntries(categories.map((c) => [c.slug, c.name])), [categories]);
  const subName = useMemo(() => {
    const m: Record<string, string> = {};
    for (const c of categories) for (const s of c.subcategories) m[s.slug] = s.name;
    return m;
  }, [categories]);

  // All view: filter by umbrella tab + search.
  const allFiltered = useMemo(() => {
    const group = GROUPS.find((g) => g.key === allGroup);
    const cats = group && group.cats.length ? new Set(group.cats) : null;
    const inGroup = cats ? entries.filter((e) => cats.has(e.category)) : entries;
    return rank(inGroup, query); // relevance-ranked when searching, registry order otherwise
  }, [entries, allGroup, query]);

  // Category view: entries in the active category, ranked by search, grouped by subcategory.
  const catGroups = useMemo(() => {
    if (isAll) return [] as [string, EntrySummary[]][];
    const inCat = rank(entries.filter((e) => e.category === view), query);
    const map = new Map<string, EntrySummary[]>();
    for (const e of inCat) {
      if (!map.has(e.subcategory)) map.set(e.subcategory, []);
      map.get(e.subcategory)!.push(e);
    }
    return [...map.entries()];
  }, [entries, view, query, isAll]);
  const catCount = useMemo(() => catGroups.reduce((n, [, es]) => n + es.length, 0), [catGroups]);

  async function open(entry: EntrySummary) {
    setOpenEntry(entry);
    setDetail(null);
    const findFn = (arr: Service[]) => arr.find((s) => s.id === entry.id) ?? null;
    const cached = cache.current.get(entry.subcategory);
    if (cached) {
      setDetail(findFn(cached));
      return;
    }
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/subcat/${entry.subcategory}`);
      if (res.ok) {
        const arr = (await res.json()) as Service[];
        cache.current.set(entry.subcategory, arr);
        setDetail(findFn(arr));
      }
    } finally {
      setDetailLoading(false);
    }
  }

  // All-view card click: toggle selection in bundle mode, otherwise open the detail sheet.
  const onEntry = (entry: EntrySummary) => (selectMode ? toggleSelect(entry) : open(entry));

  const selectAll = () => {
    setView(ALL_SLUG);
    setSidebarOpen(false);
  };
  const selectCat = (slug: string) => {
    setView(slug);
    setSidebarOpen(true);
  };

  return (
    <SidebarProvider open={sidebarOpen} onOpenChange={setSidebarOpen}>
      <Sidebar collapsible="offcanvas">
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Browse</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton isActive={isAll} onClick={selectAll} tooltip="All Categories">
                    <LayoutGrid />
                    <span>All Categories</span>
                  </SidebarMenuButton>
                  <SidebarMenuBadge>{total}</SidebarMenuBadge>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          <SidebarSeparator />
          <SidebarGroup>
            <SidebarGroupLabel>Categories</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {categories.map((cat) => {
                  const Icon = categoryIcons[cat.slug];
                  return (
                    <SidebarMenuItem key={cat.slug}>
                      <SidebarMenuButton isActive={cat.slug === view} onClick={() => selectCat(cat.slug)} tooltip={cat.name}>
                        {Icon && <Icon />}
                        <span>{cat.name}</span>
                      </SidebarMenuButton>
                      <SidebarMenuBadge>{cat.count}</SidebarMenuBadge>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter className="p-4">
          <div className="flex items-center justify-between gap-2">
            <LogoThemeToggle label="Masterkey" />
            <IntroReplayEgg />
          </div>
        </SidebarFooter>
      </Sidebar>

      <SidebarInset>
        <header className="sticky top-0 z-40 flex items-center gap-2 border-b border-border bg-background/95 px-4 py-3 backdrop-blur-sm">
          <SidebarTrigger className="-ml-1" />
          {!isAll && (
            <div className="max-w-md flex-1">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="text"
                  placeholder={`Search ${catName[view] ?? "services"}…`}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="pl-9 pr-8"
                />
                {query && (
                  <button
                    onClick={() => setQuery("")}
                    className="absolute right-3 top-1/2 -translate-y-1/2 cursor-pointer text-muted-foreground hover:text-foreground"
                    aria-label="Clear search"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
          )}
          <div className="ml-auto flex items-center gap-3">
            <AccountMenu />
          </div>
        </header>

        {isAll ? (
          // ---------- Search-first All view ----------
          <div className={cn("flex-1 overflow-y-auto px-4 py-6 lg:px-6", selectMode && "pb-56")}>
            <div className="mx-auto max-w-5xl">
              {/* describe-a-goal composer (W2). Home composer sits high on the page → drop the
                  "@"/"/" menus DOWN so they don't clip off the top of the viewport. */}
              <div className="mb-5">
                <Composer menuPlacement="down" />
              </div>
              {/* hero search */}
              <div className="relative mb-5">
                <Search className="absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="text"
                  autoFocus
                  placeholder="Search 380+ models & services…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="h-12 w-full rounded-xl border border-border bg-card pl-12 pr-10 text-base shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
                />
                {query && (
                  <button
                    onClick={() => setQuery("")}
                    className="absolute right-4 top-1/2 -translate-y-1/2 cursor-pointer text-muted-foreground hover:text-foreground"
                    aria-label="Clear search"
                  >
                    <X className="h-5 w-5" />
                  </button>
                )}
              </div>

              {/* umbrella tabs */}
              <div className="mb-4 flex items-center gap-1 overflow-x-auto border-b border-border">
                {GROUPS.map((g) => (
                  <button
                    key={g.key}
                    onClick={() => setAllGroup(g.key)}
                    className={cn(
                      "shrink-0 border-b-2 px-3 py-2 text-sm transition-colors -mb-px",
                      allGroup === g.key
                        ? "border-primary font-medium text-foreground"
                        : "border-transparent text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {g.label}
                  </button>
                ))}
              </div>

              {/* count + bundle toggle + view toggle */}
              <div className="mb-3 flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">{allFiltered.length} services · Last synced {lastSynced}</span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => (selectMode ? exitSelect() : setSelectMode(true))}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors",
                      selectMode
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {selectMode ? <Check className="h-4 w-4" /> : <CheckSquare className="h-4 w-4" />}
                    {selectMode ? "Done" : "Create bundle"}
                  </button>
                  <div className="inline-flex rounded-md border border-border p-0.5">
                    <button
                      onClick={() => setAllMode("list")}
                      aria-label="List view"
                      className={cn("rounded p-1.5 transition-colors", allMode === "list" ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground")}
                    >
                      <List className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => setAllMode("overview")}
                      aria-label="Overview"
                      className={cn("rounded p-1.5 transition-colors", allMode === "overview" ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground")}
                    >
                      <LayoutGrid className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </div>

              {allFiltered.length === 0 ? (
                <p className="py-12 text-center text-sm text-muted-foreground">
                  No results for {JSON.stringify(query)}
                </p>
              ) : allMode === "list" ? (
                <div className="flex flex-col gap-1.5">
                  {allFiltered.map((e) => (
                    <ListRow
                      key={`${e.subcategory}:${e.id}`}
                      entry={e}
                      onOpen={() => onEntry(e)}
                      selectMode={selectMode}
                      selected={selectedIds.has(e.id)}
                    />
                  ))}
                </div>
              ) : (
                <Overview
                  items={allFiltered}
                  catOrder={catOrder}
                  catName={catName}
                  subName={subName}
                  onOpen={onEntry}
                  selectMode={selectMode}
                  selectedIds={selectedIds}
                />
              )}
            </div>
          </div>
        ) : (
          // ---------- Per-category grid view ----------
          <div className="flex-1 overflow-y-auto p-4 lg:p-6">
            <div className="mb-6">
              <h2 className="mb-1 font-heading text-3xl font-normal italic">{catName[view]}</h2>
              <p className="text-sm text-muted-foreground">{catCount} services</p>
            </div>
            {catGroups.length === 0 ? (
              <p className="py-12 text-center text-sm text-muted-foreground">
                {query ? `No results for ${JSON.stringify(query)}` : "Nothing here yet."}
              </p>
            ) : (
              <div className="flex flex-col gap-8">
                {catGroups.map(([sub, items]) => (
                  <section key={sub}>
                    <h3 className="mb-3 font-heading text-xl font-normal italic text-foreground">
                      {subName[sub] ?? sub}
                      <span className="ml-2 align-middle text-xs not-italic text-muted-foreground">{items.length}</span>
                    </h3>
                    <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                      {items.map((e) => (
                        <EntryCard key={`${e.subcategory}:${e.id}`} entry={e} onOpen={() => open(e)} />
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </div>
        )}
      </SidebarInset>

      {isAll && selectMode && (
        <BundleBar
          selected={selected}
          onRemove={removeSelect}
          onClear={() => setSelected([])}
          onAddServices={addSelect}
        />
      )}

      <Sheet open={!!openEntry} onOpenChange={(o) => !o && setOpenEntry(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
          {openEntry && (
            <>
              <SheetHeader>
                <div className="flex items-center gap-2.5">
                  <Favicon domain={openEntry.domain} name={openEntry.name} size={24} />
                  <div className="min-w-0">
                    <SheetTitle className="truncate">{openEntry.name}</SheetTitle>
                    <SheetDescription className="truncate">
                      {openEntry.provider} · {catName[openEntry.category] ?? openEntry.category}
                    </SheetDescription>
                  </div>
                </div>
              </SheetHeader>
              <div className="px-4 pb-6">
                {detailLoading && !detail ? (
                  <div className="space-y-3">
                    <Skeleton className="h-4 w-full" />
                    <Skeleton className="h-4 w-3/4" />
                    <Skeleton className="h-24 w-full" />
                  </div>
                ) : detail ? (
                  <DetailBody service={detail} />
                ) : (
                  <p className="text-sm text-muted-foreground">Details unavailable.</p>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </SidebarProvider>
  );
}
