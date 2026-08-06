// Verifies health reports the SQLite database the session rows come from.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildHealthSessionSummary } from "./collector.js";

describe("buildHealthSessionSummary store path", () => {
  it("reports the SQLite database rather than the legacy sessions.json locator", async () => {
    // resolveStorePath still yields this JSON locator for the default store, but
    // no such file is written any more; entries are read from SQLite.
    const storePath = path.join(
      "/tmp",
      "openclaw-health",
      "agents",
      "main",
      "sessions",
      "sessions.json",
    );

    const summary = await buildHealthSessionSummary(storePath, "main");

    expect(summary.path.endsWith("sessions.json")).toBe(false);
    expect(summary.path).toBe(
      path.join("/tmp", "openclaw-health", "agents", "main", "agent", "openclaw-agent.sqlite"),
    );
  });

  it("keeps an explicit .sqlite store path as given", async () => {
    const storePath = path.join("/tmp", "openclaw-health", "custom", "store.sqlite");

    const summary = await buildHealthSessionSummary(storePath, "main");

    expect(summary.path).toBe(storePath);
  });
});
