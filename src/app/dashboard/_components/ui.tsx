import { cn } from "@/lib/utils";

/** Page title + description, reused at the top of every dashboard page. */
export function PageHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mb-6">
      <h1 className="font-heading text-3xl font-normal italic text-foreground">{title}</h1>
      {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
    </div>
  );
}

/** White card with an optional header (title + description) and a right-aligned action slot. */
export function SectionCard({
  title,
  description,
  action,
  children,
  className,
}: {
  title?: React.ReactNode;
  description?: string;
  action?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-xl border border-border bg-card p-5 shadow-sm shadow-black/[0.02]", className)}>
      {(title || action) && (
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            {title && <h2 className="text-base font-semibold text-foreground">{title}</h2>}
            {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** Small label/value row for read-only fields. */
export function InfoRow({ label, value, className }: { label: string; value: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-center justify-between gap-3 py-1.5 text-sm", className)}>
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-foreground">{value}</span>
    </div>
  );
}

/** Inline "Saved" confirmation that fades in after a successful save. */
export function SavedHint({ show }: { show: boolean }) {
  if (!show) return null;
  return <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">Saved</span>;
}
