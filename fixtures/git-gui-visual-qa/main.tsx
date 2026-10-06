import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import GitRepositoryView from "../../src/components/git/GitRepositoryView";
import { applyTheme } from "../../src/theme/applyTheme";
import "../../src/styles.css";

function Fixture() {
  const [view, setView] = useState("status");
  useEffect(() => {
    (window as any).__qa = {
      setTheme: applyTheme,
      setView: (next: string) => { localStorage.setItem("redline.git.view", JSON.stringify(next)); setView(next); },
    };
    document.documentElement.dataset.qaReady = "true";
  }, []);
  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: "var(--color-paper)" }}>
      <GitRepositoryView key={view} repo="/code/redline" onOpenTerminal={() => {}} />
    </div>
  );
}
localStorage.setItem("redline.git.view", JSON.stringify("status"));
applyTheme("studio");
createRoot(document.getElementById("root")!).render(<Fixture />);
