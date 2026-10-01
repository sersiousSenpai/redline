// SPDX-License-Identifier: Apache-2.0
import { createContext, useContext } from "react";

/** Shared routing metadata. Each surface owns its presentation and target. */
export const MonochatContext = createContext<{
  harness: import("../lib/backendChoice").BackendChoice;
  conversationId: string | null;
  reportActivity?: (key: string, active: boolean) => void;
} | null>(null);
export const useMonochat = () => useContext(MonochatContext);
