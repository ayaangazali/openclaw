import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleClickClackInbound } from "./inbound.js";
import { setClickClackRuntime } from "./runtime.js";
import type { ClickClackMessage, CoreConfig, ResolvedClickClackAccount } from "./types.js";

const sendClickClackTextMock = vi.hoisted(() => vi.fn());

vi.mock("./outbound.js", () => ({
  sendClickClackText: sendClickClackTextMock,
}));

function createRuntime(): PluginRuntime {
  return createPluginRuntimeMock({
    llm: {
      complete: vi.fn().mockResolvedValue({
        text: "service bot online",
        provider: "openai",
        model: "gpt-5.4-mini",
        agentId: "service-bot",
        usage: {},
        execution: {
          mode: "direct-provider",
          owner: { kind: "provider", id: "openai" },
        },
        audit: { caller: { kind: "plugin", id: "clickclack" } },
      }),
    },
  } as unknown as PluginRuntime);
}

function createAccount(): ResolvedClickClackAccount {
  return {
    accountId: "model-loop-account",
    enabled: true,
    configured: true,
    baseUrl: "http://127.0.0.1:8080",
    apiEndpoint: "http://127.0.0.1:8080",
    token: "test-token-placeholder",
    workspace: "wsp_model_loop",
    botUserId: "usr_model_receiver",
    agentId: "service-bot",
    replyMode: "model",
    toolsAllow: [],
    defaultTo: "channel:general",
    allowFrom: ["usr_model_sender"],
    allowBots: true,
    botLoopProtection: { maxEventsPerWindow: 1, windowSeconds: 60, cooldownSeconds: 60 },
    reconnectMs: 1_500,
    agentActivity: false,
    nativeProgress: false,
    commandMenu: true,
    discussions: { enabled: false, workspace: "wsp_model_loop", section: "Sessions" },
    config: {},
    requireMention: false,
    mentionPatterns: [],
    groups: {},
  };
}

describe("ClickClack direct-model response prefix", () => {
  beforeEach(() => {
    sendClickClackTextMock.mockClear();
  });

  // Model mode bypasses the agent reply pipeline, so the documented
  // responsePrefix has to be resolved on this path or it is accepted and never
  // rendered. The templated case pins that the selected model reaches the
  // prefix context, which a plain string prefix would not prove.
  it("renders root, account, and templated prefixes on model replies", async () => {
    const cases = [
      {
        label: "root",
        cfg: { channels: { clickclack: { responsePrefix: "[bot]" } } },
        expected: "[bot] service bot online",
      },
      {
        label: "account",
        cfg: {
          channels: {
            clickclack: {
              responsePrefix: "[root]",
              accounts: { "model-loop-account": { responsePrefix: "[svc]" } },
            },
          },
        },
        expected: "[svc] service bot online",
      },
      {
        label: "templated",
        cfg: { channels: { clickclack: { responsePrefix: "[{model}]" } } },
        expected: "[gpt-5.4-mini] service bot online",
      },
    ];

    for (const testCase of cases) {
      sendClickClackTextMock.mockClear();
      setClickClackRuntime(createRuntime());
      const message = {
        id: "msg_01arz3ndektsv4rrffq69g5fca",
        workspace_id: "wsp_model_loop",
        direct_conversation_id: "dm_model_prefix",
        author_id: "usr_model_sender",
        thread_root_id: "msg_01arz3ndektsv4rrffq69g5fca",
        body: "hello bot",
        body_format: "markdown" as const,
        created_at: "2026-05-09T12:00:00.000Z",
        author: {
          id: "usr_model_sender",
          kind: "human" as const,
          display_name: "Model sender",
          handle: "model-sender",
          avatar_url: "",
          created_at: "2026-05-09T12:00:00.000Z",
        },
      } satisfies ClickClackMessage;

      await handleClickClackInbound({
        account: createAccount(),
        config: testCase.cfg as unknown as CoreConfig,
        message,
      });

      expect(sendClickClackTextMock.mock.calls[0]?.[0]?.text, testCase.label).toBe(
        testCase.expected,
      );
    }
  });

  it("does not add a second prefix when the completion already opens with one", () => {
    // systemPrompt is operator-owned, so a model can be told to emit the prefix
    // itself; concatenating unconditionally would send "[bot] [bot] ...".
    sendClickClackTextMock.mockClear();
    const runtime = createRuntime();
    (
      runtime.llm.complete as unknown as { mockResolvedValue: (v: unknown) => void }
    ).mockResolvedValue({
      text: "[bot] service bot online",
      provider: "openai",
      model: "gpt-5.4-mini",
      agentId: "service-bot",
      usage: {},
      execution: { mode: "direct-provider", owner: { kind: "provider", id: "openai" } },
      audit: { caller: { kind: "plugin", id: "clickclack" } },
    });
    setClickClackRuntime(runtime);
    const message = {
      id: "msg_01arz3ndektsv4rrffq69g5fcb",
      workspace_id: "wsp_model_loop",
      channel_id: "chn_model_prefix_dedupe",
      author_id: "usr_model_sender",
      thread_root_id: "msg_01arz3ndektsv4rrffq69g5fcb",
      body: "hello bot",
      body_format: "markdown" as const,
      created_at: "2026-05-09T12:00:00.000Z",
    };

    return handleClickClackInbound({
      account: createAccount(),
      config: {
        channels: { clickclack: { responsePrefix: "[bot]" } },
      } as unknown as CoreConfig,
      message,
      access: createAccess({ eventId: message.id, conversationId: "chn_model_prefix_dedupe" }),
    }).then(() => {
      expect(sendClickClackTextMock.mock.calls[0]?.[0]?.text).toBe("[bot] service bot online");
    });
  });
});

describe("ClickClack direct-model bot loop protection", () => {
  beforeEach(() => {
    sendClickClackTextMock.mockClear();
  });

  it("suppresses the second bot message before model completion", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);
    const account = createAccount();
    const message = {
      id: "msg_01arz3ndektsv4rrffq69g5fbx",
      workspace_id: "wsp_model_loop",
      direct_conversation_id: "dm_model_loop_suppression",
      author_id: "usr_model_sender",
      thread_root_id: "msg_01arz3ndektsv4rrffq69g5fbx",
      body: "hello from the other bot",
      body_format: "markdown" as const,
      created_at: "2026-05-09T12:00:00.000Z",
      author: {
        id: "usr_model_sender",
        kind: "bot" as const,
        display_name: "Model sender",
        handle: "model-sender",
        avatar_url: "",
        created_at: "2026-05-09T12:00:00.000Z",
      },
    } satisfies ClickClackMessage;

    await handleClickClackInbound({
      account,
      config: {} as CoreConfig,
      message,
    });
    await handleClickClackInbound({
      account,
      config: {} as CoreConfig,
      message: { ...message, id: "msg_01arz3ndektsv4rrffq69g5fby" },
    });

    expect(runtime.llm.complete).toHaveBeenCalledTimes(1);
    expect(sendClickClackTextMock).toHaveBeenCalledTimes(1);
  });

  it("retries the same bot message without consuming another loop slot", async () => {
    const runtime = createRuntime();
    const complete = vi.mocked(runtime.llm.complete);
    complete.mockRejectedValueOnce(new Error("transient model failure"));
    setClickClackRuntime(runtime);
    const account = createAccount();
    const message = {
      id: "msg_01arz3ndektsv4rrffq69g5fbz",
      workspace_id: "wsp_model_loop",
      direct_conversation_id: "dm_model_loop_retry",
      author_id: "usr_model_sender",
      thread_root_id: "msg_01arz3ndektsv4rrffq69g5fbz",
      body: "retry this message",
      body_format: "markdown" as const,
      created_at: "2026-05-09T12:00:00.000Z",
      author: {
        id: "usr_model_sender",
        kind: "bot" as const,
        display_name: "Model sender",
        handle: "model-sender",
        avatar_url: "",
        created_at: "2026-05-09T12:00:00.000Z",
      },
    } satisfies ClickClackMessage;

    await expect(
      handleClickClackInbound({ account, config: {} as CoreConfig, message }),
    ).rejects.toThrow("transient model failure");
    await handleClickClackInbound({ account, config: {} as CoreConfig, message });

    expect(complete).toHaveBeenCalledTimes(2);
    expect(sendClickClackTextMock).toHaveBeenCalledTimes(1);
  });
});
