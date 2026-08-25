// Masterkey — Bundle Studio persistence (server-only). Never import from client code.
//
// User-authored bundles live in Mongo (COLLECTIONS.bundles); curated bundles keep loading from
// data/bundles/*.json via src/lib/bundles.ts and are merged in as read-only BundleDocs (ownerUserId: null,
// source: "curated"). Slug resolution is OWN-THEN-CURATED (spec §1.2): a user's own "/my-flow" shadows a
// curated one for that user only. Ownership is enforced everywhere (others' bundles read as null → the API
// surfaces 404, mirroring runs §13.1).

import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import { COLLECTIONS } from "@/lib/mcp/types";
import { ensureIndexes } from "@/lib/mcp/indexes";
import { getBundle, getBundles, type Bundle } from "@/lib/bundles";
import type { UserDoc } from "@/lib/mcp/types";
import { SLUG_RE, type BundleDoc } from "./types";

const CURATED_ID_PREFIX = "curated_";

function nowISO(): string {
  return new Date().toISOString();
}

function mintId(): string {
  return `bndl_${randomUUID().replace(/-/g, "")}`;
}

/** Lift a curated file Bundle into the unified BundleDoc shape (read-only; ownerUserId: null). */
function curatedToDoc(b: Bundle): BundleDoc {
  return {
    _id: `${CURATED_ID_PREFIX}${b.slug}`,
    slug: b.slug,
    name: b.name,
    description: b.description,
    trigger: b.trigger,
    ownerUserId: null,
    source: "curated",
    ...(b.graph ? { graph: b.graph } : {}),
    ...(b.steps ? { steps: b.steps } : {}),
    inputs: b.inputs,
    status: "ready", // curated bundles are shipped tested
    createdISO: "",
    updatedISO: "",
  };
}

/**
 * List bundles for the library. A signed-in user gets: their OWN bundles (any status), then every OTHER
 * user's PUBLIC bundles, then curated. "Public" == status:"ready" — marking a bundle ready (passing its
 * E2E test) publishes it to the shared "All" tab. Anonymous callers see curated only (must sign in to
 * browse community skills). Own bundles first (newest), then shared, then curated. Dedup is implicit:
 * publicOthers excludes the viewer's own (ownerUserId $ne userId), so a user's own ready bundle appears
 * once (in `own`), never twice.
 */
export async function listBundles(userId: string | null): Promise<BundleDoc[]> {
  const curated = getBundles().map(curatedToDoc);
  if (!userId) return curated;
  const db = await getDb();
  const col = db.collection<BundleDoc>(COLLECTIONS.bundles);
  const own = await col.find({ ownerUserId: userId }).sort({ updatedISO: -1 }).toArray();
  const publicOthers = await col
    .find({ status: "ready", ownerUserId: { $ne: userId } })
    .sort({ updatedISO: -1 })
    .toArray();
  return [...own, ...publicOthers, ...curated];
}

/**
 * Resolve a bundle by id for RUNNING a shared/public one (the "All" tab surfaces other users' bundles).
 * Curated ids resolve from files; a Mongo id resolves ONLY if the bundle is public (status:"ready") — so a
 * user can run someone else's published bundle but never reach a private draft. The runner pays with their
 * OWN wallet/spend; the shared bundle only supplies the recipe. (Editing/deleting still require ownership
 * via getBundleById.)
 */
export async function getPublicBundleById(id: string): Promise<BundleDoc | null> {
  if (id.startsWith(CURATED_ID_PREFIX)) {
    const cur = getBundle(id.slice(CURATED_ID_PREFIX.length));
    return cur ? curatedToDoc(cur) : null;
  }
  const db = await getDb();
  const doc = await db.collection<BundleDoc>(COLLECTIONS.bundles).findOne({ _id: id, status: "ready" });
  return doc ?? null;
}

/** Resolve a bundle by id. Curated ids ("curated_<slug>") resolve from files; Mongo ids are ownership-checked. */
export async function getBundleById(id: string, userId: string | null): Promise<BundleDoc | null> {
  if (id.startsWith(CURATED_ID_PREFIX)) {
    const cur = getBundle(id.slice(CURATED_ID_PREFIX.length));
    return cur ? curatedToDoc(cur) : null;
  }
  const db = await getDb();
  const doc = await db.collection<BundleDoc>(COLLECTIONS.bundles).findOne({ _id: id });
  if (!doc) return null;
  if (doc.ownerUserId !== userId) return null; // ownership (read as not-found)
  return doc;
}

/** Own-then-curated slug resolution (spec §1.2). Anonymous callers resolve curated only. */
export async function getBundleBySlug(slug: string, userId: string | null): Promise<BundleDoc | null> {
  if (!SLUG_RE.test(slug)) return null;
  if (userId) {
    const db = await getDb();
    const own = await db.collection<BundleDoc>(COLLECTIONS.bundles).findOne({ ownerUserId: userId, slug });
    if (own) return own;
  }
  const cur = getBundle(slug);
  return cur ? curatedToDoc(cur) : null;
}

/**
 * Upsert a user bundle. Mints a `bndl_…` id for new docs; preserves createdISO; stamps updatedISO. The
 * filter is keyed on (_id, ownerUserId) so one user can never overwrite another's bundle (a colliding _id
 * with a different owner fails the unique _id on insert). Slug uniqueness per owner is enforced by the
 * {ownerUserId, slug} unique index — callers (§5.3) mint a unique slug; a duplicate throws here.
 */
export async function saveBundle(doc: BundleDoc): Promise<BundleDoc> {
  if (!doc.ownerUserId) throw new Error("saveBundle requires a non-null ownerUserId (curated bundles are file-based).");
  await ensureIndexes();
  const db = await getDb();
  const col = db.collection<BundleDoc>(COLLECTIONS.bundles);
  const now = nowISO();
  const _id = doc._id && doc._id.startsWith("bndl_") ? doc._id : mintId();
  const toSave: BundleDoc = { ...doc, _id, updatedISO: now, createdISO: doc.createdISO || now };
  await col.replaceOne({ _id, ownerUserId: doc.ownerUserId }, toSave, { upsert: true });
  return toSave;
}

/** Delete a user bundle (own only). Curated bundles cannot be deleted. Returns true if one was removed. */
export async function deleteBundle(id: string, userId: string): Promise<boolean> {
  if (id.startsWith(CURATED_ID_PREFIX)) return false;
  const db = await getDb();
  const res = await db.collection<BundleDoc>(COLLECTIONS.bundles).deleteOne({ _id: id, ownerUserId: userId });
  return res.deletedCount === 1;
}

/**
 * Mint a slug unique to this owner (spec §5.3). Starts from `base` (already kebab via deriveSlug), then
 * appends -2, -3, … until free. `excludeId` lets a rename keep its own slug. Curated/global slugs do NOT
 * block a user slug (resolution is own-then-curated), so we only check the user's own bundles.
 */
export async function mintUniqueSlug(userId: string, base: string, excludeId?: string): Promise<string> {
  const db = await getDb();
  const col = db.collection<BundleDoc>(COLLECTIONS.bundles);
  let slug = base;
  for (let i = 2; ; i++) {
    const clash = await col.findOne({ ownerUserId: userId, slug });
    if (!clash || clash._id === excludeId) return slug;
    slug = `${base}-${i}`;
  }
}

/**
 * Toggle a bundle slug in the user's favorites (spec §1.7/§5.2). Favorites are keyed by SLUG so both
 * curated and the user's own bundles are favoritable. Returns the NEW favorite state.
 */
export async function toggleFavoriteBundleSlug(userId: string, slug: string): Promise<boolean> {
  const db = await getDb();
  const users = db.collection<UserDoc>(COLLECTIONS.users);
  const u = await users.findOne({ _id: userId });
  const has = (u?.favoriteBundleSlugs ?? []).includes(slug);
  await users.updateOne(
    { _id: userId },
    has
      ? { $pull: { favoriteBundleSlugs: slug }, $set: { updatedISO: nowISO() } }
      : { $addToSet: { favoriteBundleSlugs: slug }, $set: { updatedISO: nowISO() } },
  );
  return !has;
}

/** Mark a user bundle `ready` after a passing whole-bundle E2E test (spec §10). Returns true if updated. */
export async function setReady(id: string, userId: string, testedISO: string): Promise<boolean> {
  if (id.startsWith(CURATED_ID_PREFIX)) return false;
  const db = await getDb();
  const res = await db
    .collection<BundleDoc>(COLLECTIONS.bundles)
    .updateOne(
      { _id: id, ownerUserId: userId },
      { $set: { status: "ready", lastTestedISO: testedISO, updatedISO: nowISO() } },
    );
  return res.matchedCount === 1;
}
