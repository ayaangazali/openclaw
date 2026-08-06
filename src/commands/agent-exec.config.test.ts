// Agent exec tests cover config resolution and run-config layering.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveRunWorkspaceDir } from "../agents/workspace-run.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildExecRunConfig, resolveExecBaseConfig } from "./agent-exec.js";

const tempRoots: string[] = [];

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("agent exec run config layering", () => {
  it("keeps the run scoped to the invocation folder over any config", () => {
    const config = buildExecRunConfig({
      base: { agents: { defaults: { workspace: "/elsewhere", skipBootstrap: false } } },
      cwd: "/run/here",
    });

    expect(config.agents?.defaults?.workspace).toBe("/run/here");
    expect(config.agents?.defaults?.skipBootstrap).toBe(true);
  });

  it("declares an explicit roster so a rosterless base can resolve a workspace", () => {
    // --isolated and --auth-env-only hand buildExecRunConfig an empty base by
    // design. resolveRunWorkspaceDir refuses to invent a workspace owner, so
    // without an explicit entry the run cannot reach the model at all.
    const config = buildExecRunConfig({ base: {}, cwd: "/run/here" });

    expect(Object.keys(config.agents?.entries ?? {})).toEqual(["main"]);
    expect(config.agents?.entries?.main?.workspace).toBe("/run/here");
    expect(() => resolveRunWorkspaceDir({ config, workspaceDir: "/run/here" })).not.toThrow();
  });

  it("still pins every configured entry to the invocation folder", () => {
    const config = buildExecRunConfig({
      base: { agents: { entries: { main: { workspace: "/a" }, ops: { workspace: "/b" } } } },
      cwd: "/run/here",
    });

    expect(Object.keys(config.agents?.entries ?? {}).toSorted()).toEqual(["main", "ops"]);
    expect(config.agents?.entries?.ops?.workspace).toBe("/run/here");
  });

  it("never downgrades a configured sandbox or shell env to the exec defaults", () => {
    const config = buildExecRunConfig({
      base: {
        env: { shellEnv: { enabled: true } },
        agents: { defaults: { sandbox: { mode: "all" } } },
        tools: { profile: "full" },
      },
      cwd: "/run/here",
    });

    expect(config.agents?.defaults?.sandbox?.mode).toBe("all");
    expect(config.env?.shellEnv?.enabled).toBe(true);
    expect(config.tools?.profile).toBe("full");
  });

  it("applies coding one-shot defaults when the config leaves them unset", () => {
    const config = buildExecRunConfig({ base: {}, cwd: "/run/here" });

    expect(config.agents?.defaults?.sandbox?.mode).toBe("off");
    expect(config.env?.shellEnv?.enabled).toBe(false);
    expect(config.tools?.profile).toBe("coding");
    expect(config.tools?.fs?.workspaceOnly).toBe(true);
  });

  it("leaves exec host routing to the configured sandbox", () => {
    const sandboxed = buildExecRunConfig({
      base: { agents: { defaults: { sandbox: { mode: "all" } } } },
      cwd: "/run/here",
    });

    expect(sandboxed.agents?.defaults?.sandbox?.mode).toBe("all");
    expect(sandboxed.tools?.exec?.host).toBeUndefined();
    expect(buildExecRunConfig({ base: {}, cwd: "/run/here" }).tools?.exec?.host).toBeUndefined();
  });

  it("carries config-owned provider and harness surfaces into the run", () => {
    const config = buildExecRunConfig({
      base: {
        models: { providers: { custom: { baseUrl: "https://example.invalid", models: [] } } },
        tools: { codeMode: { enabled: true } },
      },
      cwd: "/run/here",
    });

    expect(config.models?.providers?.custom?.baseUrl).toBe("https://example.invalid");
    expect(config.tools?.codeMode).toMatchObject({ enabled: true });
  });

  it("pins per-agent workspaces to the invocation folder", () => {
    const config = buildExecRunConfig({
      base: { agents: { entries: { ops: { workspace: "/elsewhere" } } } },
      cwd: "/run/here",
    });

    expect(config.agents?.entries?.ops?.workspace).toBe("/run/here");
  });

  it("drops inherited agent directories so run state stays in the state dir", () => {
    const config = buildExecRunConfig({
      base: {
        agents: {
          entries: { ops: { agentDir: "/persistent/agents/ops", model: "openai/gpt-5.6-sol" } },
        },
      },
      cwd: "/run/here",
    });

    expect(config.agents?.entries?.ops?.agentDir).toBeUndefined();
    // Only the directory is dropped; the rest of the entry is still inherited.
    expect(config.agents?.entries?.ops?.model).toBe("openai/gpt-5.6-sol");
  });

  it("drops an inherited harness cwd so --cwd wins", () => {
    const config = buildExecRunConfig({
      base: {
        agents: {
          entries: {
            ops: { runtime: { type: "acp", acp: { agent: "codex", cwd: "/other/repo" } } },
          },
        },
      },
      cwd: "/run/here",
    });

    const runtime = config.agents?.entries?.ops?.runtime;
    expect(runtime?.type === "acp" ? runtime.acp?.cwd : "unset").toBeUndefined();
    // The rest of the harness selection survives.
    expect(runtime?.type === "acp" ? runtime.acp?.agent : undefined).toBe("codex");
  });

  it("lets explicit flags outrank the resolved config", () => {
    const config = buildExecRunConfig({
      base: { tools: { codeMode: { enabled: true } } },
      cwd: "/run/here",
      opts: { codeMode: "direct", localModelLean: true },
    });

    expect(config.tools?.codeMode).toBe(false);
    expect(config.agents?.defaults?.experimental?.localModelLean).toBe(true);
  });
});

describe("agent exec base config resolution", () => {
  const seedConfig = {
    models: {
      providers: {
        custom: {
          apiKey: "sk-config",
          baseUrl: "https://example.invalid",
          headers: { Authorization: "Bearer header-secret" },
          request: { auth: { mode: "authorization-bearer", token: "request-secret" } },
          models: [],
        },
      },
    },
  } satisfies OpenClawConfig;

  async function writeSeed(body: string): Promise<string> {
    const dir = await makeTempRoot("openclaw-agent-exec-seed-");
    const seedPath = path.join(dir, "openclaw.json");
    await fs.writeFile(seedPath, body, "utf8");
    return seedPath;
  }

  it("rejects a missing or invalid pinned config instead of falling back", async () => {
    const missing = path.join(await makeTempRoot("openclaw-agent-exec-seed-"), "absent.json");
    await expect(resolveExecBaseConfig({ config: missing })).rejects.toThrow(
      "--config file not found",
    );

    const broken = await writeSeed("{ this is not a config");
    await expect(resolveExecBaseConfig({ config: broken })).rejects.toThrow();
  });

  it("reads the pinned file even when a runtime snapshot is already published", async () => {
    const seedPath = await writeSeed(
      JSON.stringify({
        models: { providers: { custom: { baseUrl: "https://from-file.invalid", models: [] } } },
      }),
    );
    setRuntimeConfigSnapshot({
      models: { providers: { custom: { baseUrl: "https://from-snapshot.invalid", models: [] } } },
    });

    try {
      const resolved = await resolveExecBaseConfig({ config: seedPath });
      expect(resolved.models?.providers?.custom?.baseUrl).toBe("https://from-file.invalid");
    } finally {
      clearRuntimeConfigSnapshot();
    }
  });

  it("reads --config through the JSON5-aware loader", async () => {
    const seedPath = await writeSeed(
      `{\n  // pinned run config\n  models: { providers: { custom: { baseUrl: "https://example.invalid", models: [] } } },\n}\n`,
    );

    const resolved = await resolveExecBaseConfig({ config: seedPath });

    expect(resolved.models?.providers?.custom?.baseUrl).toBe("https://example.invalid");
  });

  it("rejects --config paired with a mode that reads no config", async () => {
    const seedPath = await writeSeed(JSON.stringify(seedConfig));

    await expect(resolveExecBaseConfig({ config: seedPath, isolated: true })).rejects.toThrow(
      "--config cannot be combined with --isolated",
    );
    await expect(resolveExecBaseConfig({ config: seedPath, authEnvOnly: true })).rejects.toThrow(
      "--config cannot be combined with --auth-env-only",
    );
  });

  it("reads no config at all under --auth-env-only", async () => {
    const seedPath = await writeSeed(JSON.stringify(seedConfig));

    // A config can supply provider credentials through several surfaces, so
    // env-only means no config at all.
    await expect(resolveExecBaseConfig({ authEnvOnly: true })).resolves.toEqual({});
    // Proves the assertion above is not vacuous.
    const inherited = await resolveExecBaseConfig({ config: seedPath });
    expect(inherited.models?.providers?.custom?.apiKey).toBe("sk-config");
  });

  it("ignores the ambient config under --isolated", async () => {
    await expect(resolveExecBaseConfig({ isolated: true })).resolves.toEqual({});
  });
});
