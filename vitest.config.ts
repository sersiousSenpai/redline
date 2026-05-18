import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Editor round-trip + reconcile tests for src/editor. jsdom is needed because
// ProseMirror/Tiptap construct DOM nodes even when headless.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
