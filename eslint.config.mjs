import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  // Bundle Studio — VENDORED Flow port (spec §2.2/§2.6). These files were copied wholesale from Flow
  // (the Flow project) and run in production there. MasterKey's ESLint is stricter than Flow's
  // (React-19-era hooks rules, etc.), so we downgrade the port-intrinsic rules to "warn" for the inherited
  // files only — keeping the rest of the app strict. As these files are reworked (registry-backed config
  // §3.3, toolbar §7.7, assist §8), the violations should be fixed and this override shrunk. New, non-ported
  // studio code is NOT covered by these name globs and must satisfy the strict rules.
  {
    files: [
      "src/components/studio/**/*.{ts,tsx}",
      "src/lib/studio/workflow-store.ts",
      "src/lib/studio/api-client.ts",
      "src/lib/studio/legacy-plugins.ts",
      "src/components/ui/template-badge-input.tsx",
      "src/components/ui/template-badge-textarea.tsx",
      "src/components/ui/template-autocomplete.tsx",
      "src/components/ui/code-editor.tsx",
      "src/components/ui/animated-border.tsx",
      "src/components/ui/workflow-icon.tsx",
    ],
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/rules-of-hooks": "warn",
      "react-hooks/static-components": "warn",
      "react/no-unescaped-entities": "warn",
      "@next/next/no-html-link-for-pages": "warn",
    },
  },
]);

export default eslintConfig;
