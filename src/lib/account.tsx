"use client";

// Masterkey account store. Backed by Mongo via /api/account (was localStorage). The signed-in
// user comes from the CDP embedded wallet; when CDP reports signed-in we establish the first-party
// server session (/api/auth/check) and load the account. Anonymous users get a neutral empty
// account (no fake identity) + signedIn=false. See MCP_SPEC.md M1.

import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  useIsInitialized,
  useIsSignedIn,
  useGetAccessToken,
  useSignOut,
} from "@coinbase/cdp-hooks";
import type { RuleScope, RulePeriod } from "@/lib/spend-buckets";

export type Plan = "Free" | "Pay-as-you-go" | "Team";

export interface LinkedCard {
  brand: string; // "Visa", "Mastercard", …
  last4: string;
  linkedISO: string;
}

export interface Invoice {
  id: string;
  dateISO: string;
  amountUsd: number;
  status: "paid";
}

export interface SpendRule {
  id: string;
  scope: RuleScope;
  period: RulePeriod;
  capUsd: number;
  enabled: boolean;
}

export interface SpendAlert {
  id: string;
  pct: number; // threshold of the monthly limit, e.g. 20, 100
  email: string;
}

export interface Connection {
  id: string;
  name: string; // "Claude Code", "ChatGPT", …
  client: string; // free-form agent/client descriptor
  scopes: RuleScope[]; // ["all"] or specific buckets it's authorized for
  tokenPrefix: string; // "mk_agent" — display only
  last4: string; // last 4 of the (never-stored) full token
  createdISO: string;
  lastUsedISO?: string;
  status: "active";
}

export interface Account {
  user: {
    name: string;
    email: string;
    avatarUrl?: string;
    org: string;
    plan: Plan;
  };
  billing: {
    card: LinkedCard | null;
    /** Read-only running usage this period — ledger-derived server-side; never written by the client. */
    spentThisPeriodUsd: number;
    periodResetsISO: string;
    invoices: Invoice[];
  };
  spend: {
    monthlyLimitUsd: number;
    advancedEnabled: boolean;
    perCallMaxUsd: number | null;
    rules: SpendRule[];
    alerts: SpendAlert[];
  };
  connections: Connection[];
}

// Neutral empty account for anonymous / pre-load (no hardcoded identity — Appendix R R5).
function emptyAccount(): Account {
  return {
    user: { name: "", email: "", org: "", plan: "Free" },
    billing: { card: null, spentThisPeriodUsd: 0, periodResetsISO: "", invoices: [] },
    spend: { monthlyLimitUsd: 0, advancedEnabled: false, perCallMaxUsd: null, rules: [], alerts: [] },
    connections: [],
  };
}

// --- ID + token helpers (client-only). ---
function rid(prefix: string): string {
  const bytes = new Uint8Array(8);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(bytes);
  const body = Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 10);
  return `${prefix}_${body}`;
}

const TOKEN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789abcdefghijkmnpqrstuvwxyz";
function genToken(): { full: string; prefix: string; last4: string } {
  const bytes = new Uint8Array(28);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(bytes);
  const body = Array.from(bytes, (b) => TOKEN_ALPHABET[b % TOKEN_ALPHABET.length]).join("");
  const prefix = "mk_agent";
  return { full: `${prefix}_${body}`, prefix, last4: body.slice(-4) };
}

type AccountPatchBody = {
  profile?: Partial<{ name: string; org: string; plan: Plan; avatarUrl?: string; email: string }>;
  spend?: Partial<Account["spend"]>;
  card?: LinkedCard | null;
};

export interface AccountContextValue {
  account: Account;
  /** First load attempt has finished (kept for existing consumers). */
  hydrated: boolean;
  loading: boolean;
  signedIn: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  // profile
  updateProfile: (patch: Partial<Account["user"]>) => void;
  // billing
  linkCard: (card: { brand: string; last4: string }) => void;
  unlinkCard: () => void;
  // spend
  setMonthlyLimit: (usd: number) => void;
  setAdvancedEnabled: (on: boolean) => void;
  setPerCallMax: (usd: number | null) => void;
  addRule: (rule: { scope: RuleScope; period: RulePeriod; capUsd: number }) => void;
  updateRule: (id: string, patch: Partial<Omit<SpendRule, "id">>) => void;
  removeRule: (id: string) => void;
  addAlert: (pct: number, email: string) => void;
  removeAlert: (id: string) => void;
  // connections (mock until real OAuth connections land in M2)
  createConnection: (input: { name: string; scopes: RuleScope[] }) => { token: string; connection: Connection };
  revokeConnection: (id: string) => void;
}

const AccountContext = createContext<AccountContextValue | null>(null);

export function AccountProvider({ children }: { children: ReactNode }) {
  const { isInitialized } = useIsInitialized();
  const { isSignedIn } = useIsSignedIn();
  const { getAccessToken } = useGetAccessToken();
  const { signOut: cdpSignOut } = useSignOut();

  const [account, setAccount] = useState<Account>(emptyAccount);
  const [hydrated, setHydrated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [signedIn, setSignedIn] = useState(false);

  // Keep latest CDP values in refs so `load` can be a stable callback (no fetch storm from
  // changing function identities) while still reading current state. Refs are synced in an
  // effect (defined before the load effect) so updates land before a load runs.
  const getAccessTokenRef = useRef(getAccessToken);
  const isSignedInRef = useRef(isSignedIn);
  const cdpSignOutRef = useRef(cdpSignOut);
  const runningRef = useRef(false);

  useEffect(() => {
    getAccessTokenRef.current = getAccessToken;
    isSignedInRef.current = isSignedIn;
    cdpSignOutRef.current = cdpSignOut;
  });

  // Establish the first-party mk_session by POSTing the validated CDP access token to
  // /api/auth/check. Called proactively as soon as CDP reports signed-in (below), and as a
  // safety net on a 401 inside load(). Stable callback — reads CDP values via refs.
  const establishSession = useCallback(async (): Promise<boolean> => {
    const token = await getAccessTokenRef.current();
    if (!token) return false;
    try {
      const res = await fetch("/api/auth/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessToken: token }),
      });
      // 403 = not a Coinbase employee. The server minted no session; drop the CDP
      // session too so a devtools-bypass sign-in can't linger half-authenticated.
      if (res.status === 403) {
        try {
          await cdpSignOutRef.current();
        } catch {
          // ignore
        }
      }
      return res.ok;
    } catch {
      return false;
    }
  }, []);

  const load = useCallback(async () => {
    if (runningRef.current) return; // dedupe concurrent / StrictMode double-invokes
    runningRef.current = true;
    setLoading(true);
    try {
      let res = await fetch("/api/account");
      // Safety net: if the session isn't established yet but CDP is signed in, establish + retry once.
      if (res.status === 401 && isSignedInRef.current) {
        if (await establishSession()) res = await fetch("/api/account");
      }
      if (res.ok) {
        setAccount((await res.json()) as Account);
        setSignedIn(true);
      } else {
        setAccount(emptyAccount());
        setSignedIn(false);
      }
    } catch {
      setAccount(emptyAccount());
      setSignedIn(false);
    } finally {
      setLoading(false);
      setHydrated(true);
      runningRef.current = false;
    }
  }, [establishSession]);

  // When CDP auth resolves/changes: proactively establish the server session on sign-in
  // (so it doesn't depend on hitting a 401 first), then load the account.
  useEffect(() => {
    if (!isInitialized) return;
    let cancelled = false;
    void (async () => {
      if (isSignedIn) await establishSession();
      if (!cancelled) void load();
    })();
    return () => {
      cancelled = true;
    };
  }, [isInitialized, isSignedIn, establishSession, load]);

  const patch = useCallback(async (body: AccountPatchBody) => {
    try {
      const res = await fetch("/api/account", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) setAccount((await res.json()) as Account);
    } catch {
      // keep optimistic local state on network error
    }
  }, []);

  const updateProfile = useCallback(
    (p: Partial<Account["user"]>) => {
      setAccount((a) => ({ ...a, user: { ...a.user, ...p } }));
      const { email, ...rest } = p;
      void patch({ profile: { ...rest, ...(email !== undefined ? { email } : {}) } });
    },
    [patch],
  );

  const linkCard = useCallback(
    (card: { brand: string; last4: string }) => {
      const linked: LinkedCard = { ...card, linkedISO: new Date().toISOString() };
      setAccount((a) => ({ ...a, billing: { ...a.billing, card: linked } }));
      void patch({ card: linked });
    },
    [patch],
  );

  const unlinkCard = useCallback(() => {
    setAccount((a) => ({ ...a, billing: { ...a.billing, card: null } }));
    void patch({ card: null });
  }, [patch]);

  const setMonthlyLimit = useCallback(
    (usd: number) => {
      const v = Math.max(0, usd);
      setAccount((a) => ({ ...a, spend: { ...a.spend, monthlyLimitUsd: v } }));
      void patch({ spend: { monthlyLimitUsd: v } });
    },
    [patch],
  );

  const setAdvancedEnabled = useCallback(
    (on: boolean) => {
      setAccount((a) => ({ ...a, spend: { ...a.spend, advancedEnabled: on } }));
      void patch({ spend: { advancedEnabled: on } });
    },
    [patch],
  );

  const setPerCallMax = useCallback(
    (usd: number | null) => {
      const v = usd == null ? null : Math.max(0, usd);
      setAccount((a) => ({ ...a, spend: { ...a.spend, perCallMaxUsd: v } }));
      void patch({ spend: { perCallMaxUsd: v } });
    },
    [patch],
  );

  const addRule = useCallback(
    (rule: { scope: RuleScope; period: RulePeriod; capUsd: number }) => {
      let next: SpendRule[] = [];
      setAccount((a) => {
        next = [...a.spend.rules, { id: rid("rule"), enabled: true, ...rule, capUsd: Math.max(0, rule.capUsd) }];
        return { ...a, spend: { ...a.spend, rules: next } };
      });
      void patch({ spend: { rules: next } });
    },
    [patch],
  );

  const updateRule = useCallback(
    (id: string, p: Partial<Omit<SpendRule, "id">>) => {
      let next: SpendRule[] = [];
      setAccount((a) => {
        next = a.spend.rules.map((r) =>
          r.id === id ? { ...r, ...p, capUsd: p.capUsd != null ? Math.max(0, p.capUsd) : r.capUsd } : r,
        );
        return { ...a, spend: { ...a.spend, rules: next } };
      });
      void patch({ spend: { rules: next } });
    },
    [patch],
  );

  const removeRule = useCallback(
    (id: string) => {
      let next: SpendRule[] = [];
      setAccount((a) => {
        next = a.spend.rules.filter((r) => r.id !== id);
        return { ...a, spend: { ...a.spend, rules: next } };
      });
      void patch({ spend: { rules: next } });
    },
    [patch],
  );

  const addAlert = useCallback(
    (pct: number, email: string) => {
      let next: SpendAlert[] = [];
      setAccount((a) => {
        next = [...a.spend.alerts, { id: rid("alert"), pct: Math.max(1, Math.min(100, pct)), email }];
        return { ...a, spend: { ...a.spend, alerts: next } };
      });
      void patch({ spend: { alerts: next } });
    },
    [patch],
  );

  const removeAlert = useCallback(
    (id: string) => {
      let next: SpendAlert[] = [];
      setAccount((a) => {
        next = a.spend.alerts.filter((al) => al.id !== id);
        return { ...a, spend: { ...a.spend, alerts: next } };
      });
      void patch({ spend: { alerts: next } });
    },
    [patch],
  );

  // Connections remain client-local until real OAuth connections land in M2 (Appendix R6).
  const createConnection = useCallback((input: { name: string; scopes: RuleScope[] }) => {
    const { full, prefix, last4 } = genToken();
    const connection: Connection = {
      id: rid("conn"),
      name: input.name,
      client: "MCP / OAuth",
      scopes: input.scopes.length ? input.scopes : ["all"],
      tokenPrefix: prefix,
      last4,
      createdISO: new Date().toISOString(),
      status: "active",
    };
    setAccount((a) => ({ ...a, connections: [connection, ...a.connections] }));
    return { token: full, connection };
  }, []);

  const revokeConnection = useCallback((id: string) => {
    setAccount((a) => ({ ...a, connections: a.connections.filter((c) => c.id !== id) }));
  }, []);

  const signOut = useCallback(async () => {
    try {
      await cdpSignOut();
    } catch {
      // ignore
    }
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // ignore
    }
    setAccount(emptyAccount());
    setSignedIn(false);
  }, [cdpSignOut]);

  const value = useMemo<AccountContextValue>(
    () => ({
      account,
      hydrated,
      loading,
      signedIn,
      refresh: load,
      signOut,
      updateProfile,
      linkCard,
      unlinkCard,
      setMonthlyLimit,
      setAdvancedEnabled,
      setPerCallMax,
      addRule,
      updateRule,
      removeRule,
      addAlert,
      removeAlert,
      createConnection,
      revokeConnection,
    }),
    [
      account,
      hydrated,
      loading,
      signedIn,
      load,
      signOut,
      updateProfile,
      linkCard,
      unlinkCard,
      setMonthlyLimit,
      setAdvancedEnabled,
      setPerCallMax,
      addRule,
      updateRule,
      removeRule,
      addAlert,
      removeAlert,
      createConnection,
      revokeConnection,
    ],
  );

  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export function useAccount(): AccountContextValue {
  const ctx = useContext(AccountContext);
  if (!ctx) throw new Error("useAccount must be used within <AccountProvider>");
  return ctx;
}

// --- Formatting + derived helpers (pure; safe to import anywhere) ---------

export function fmtUsd(n: number, opts?: { cents?: boolean }): string {
  const cents = opts?.cents ?? true;
  return `$${n.toLocaleString(undefined, {
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  })}`;
}

export function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return iso;
  }
}

/** % of the monthly limit used this period (0–100, clamped). */
export function pctUsed(account: Account): number {
  const { spentThisPeriodUsd } = account.billing;
  const { monthlyLimitUsd } = account.spend;
  if (monthlyLimitUsd <= 0) return 0;
  return Math.min(100, Math.round((spentThisPeriodUsd / monthlyLimitUsd) * 100));
}
