import { describe, expect, it } from "vitest";
import { BROWSER_HOME_URL, browserPageTitle, initialBrowserTitle } from "./browserTitle";

describe("browser tab titles", () => {
  it("knows the default page before loading, including its canonical URL", () => {
    for (const url of [BROWSER_HOME_URL, `${BROWSER_HOME_URL}/`, `${BROWSER_HOME_URL}/?client=safari`]) {
      expect(initialBrowserTitle(url)).toBe("Google");
    }
    expect(initialBrowserTitle(`${BROWSER_HOME_URL}/search?q=redline`)).toBe("www.google.com");
    expect(initialBrowserTitle("https://www.google.com.example/")).toBe("www.google.com.example");
  });

  it("keeps the page title through empty signals and same-document URL changes", () => {
    const previous = { url: "https://example.com", title: "Example dashboard" };
    expect(browserPageTitle(previous, "https://example.com/", "")).toBe(previous.title);
    expect(browserPageTitle(previous, "https://example.com/#section", "  ")).toBe(previous.title);
    expect(browserPageTitle(previous, previous.url, "Updated dashboard")).toBe("Updated dashboard");
  });

  it("does not carry the previous document's title to a different page", () => {
    const previous = { url: "https://example.com/one", title: "Page one" };
    expect(browserPageTitle(previous, "https://example.com/two")).toBe("example.com");
    expect(browserPageTitle(previous, "https://other.test")).toBe("other.test");
    expect(browserPageTitle(previous, BROWSER_HOME_URL)).toBe("Google");
  });

  it("upgrades an old hostname-only home title while accepting the page's actual title", () => {
    const previous = { url: BROWSER_HOME_URL, title: "www.google.com" };
    expect(browserPageTitle(previous, `${BROWSER_HOME_URL}/`)).toBe("Google");
    expect(browserPageTitle(previous, `${BROWSER_HOME_URL}/`, "Google — Search")).toBe("Google — Search");
  });
});
