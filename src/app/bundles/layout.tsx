// Masterkey — Bundle Studio route layout. Scopes @xyflow/react's stylesheet to the /bundles subtree
// (Bundle Library + the visual builder) using Next App Router segment-level CSS: a stylesheet imported in
// a nested layout is only loaded for that route segment, so the catalog/MCP bundle is unaffected
// (spec §2.5/§13.5). xyflow's styles are namespaced under --xy-*/.react-flow, so they don't collide with
// our OKLch design tokens in globals.css.
import "@xyflow/react/dist/style.css";

export default function BundlesLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
