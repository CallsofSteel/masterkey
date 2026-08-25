import { getIndex } from "@/lib/registry";
import Catalog from "./catalog";

// Server component: reads the server-only registry manifest and hands summaries to the
// client catalog as props (instant first paint; summaries are public). Detail is lazy-loaded
// client-side from the rate-limited /api/subcat/[slug] route.
export default function Home() {
  const index = getIndex();
  return <Catalog index={index} />;
}
