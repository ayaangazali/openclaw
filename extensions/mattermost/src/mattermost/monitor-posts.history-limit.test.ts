// Mattermost tests cover the pending-history cap the post handler applies.
import { beforeEach, describe, expect, it, vi } from "vitest";

const buildMattermostEventPlanMock = vi.hoisted(() => vi.fn());
const recordMock = vi.hoisted(() => vi.fn());

vi.mock("./monitor-event-plan.js", () => ({
  buildMattermostEventPlan: buildMattermostEventPlanMock,
}));
vi.mock("./runtime-api.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createChannelHistoryWindow: () => ({
      record: recordMock,
      buildInboundHistory: () => [],
      buildPendingContext: () => undefined,
    }),
  };
});

const { createMattermostPostHandler } = await import("./monitor-posts.js");

function createMonitor(accountConfig: Record<string, unknown>, cfg: Record<string, unknown>) {
  return {
    account: { accountId: "work", enabled: true, config: accountConfig },
    botUserId: "bot",
    botUsername: "bot",
    cfg,
    core: {
      channel: {
        activity: { record: () => {} },
        commands: {
          shouldHandleTextCommands: () => false,
          isControlCommandMessage: () => false,
        },
        // A group that requires a mention, with no mention present, is the
        // realistic way an inbound post lands in the pending window instead of
        // being dispatched.
        groups: { resolveRequireMention: () => true },
        mentions: {
          buildMentionRegexes: () => [],
          matchesMentionPatterns: () => false,
        },
        pairing: { buildPairingReply: () => undefined },
      },
    },
    groupPolicy: "open",
    pairing: {},
    resources: {
      resolveMattermostMedia: async () => [],
      resolveUserInfo: async () => ({ username: "sender" }),
    },
    logVerboseMessage: () => {},
    logDebugMessage: () => {},
  } as unknown as Parameters<typeof createMattermostPostHandler>[0];
}

async function recordedPendingLimit(
  accountConfig: Record<string, unknown>,
  cfg: Record<string, unknown>,
): Promise<unknown> {
  recordMock.mockClear();
  buildMattermostEventPlanMock.mockResolvedValue({
    channelDisplay: "General",
    kind: "group",
    roomLabel: "general",
    route: { agentId: "main" },
    thread: { effectiveReplyToId: undefined, sessionKey: "agent:main:mattermost:group:chan-1" },
    finalizeContext: () => {},
  });

  const handler = createMattermostPostHandler(createMonitor(accountConfig, cfg));
  await handler(
    {
      id: "post-1",
      channel_id: "chan-1",
      user_id: "sender",
      message: "no mention here",
      create_at: 1,
    } as never,
    { data: { sender_name: "sender" } } as never,
  );

  return recordMock.mock.calls[0]?.[0]?.limit;
}

const GLOBAL_CFG = { messages: { groupChat: { historyLimit: 7 } } };

describe("mattermost pending history cap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("hands the account value to the pending-history window", async () => {
    await expect(recordedPendingLimit({ historyLimit: 3 }, GLOBAL_CFG)).resolves.toBe(3);
  });

  it("falls back to the global value when the channel scopes set nothing", async () => {
    await expect(recordedPendingLimit({}, GLOBAL_CFG)).resolves.toBe(7);
  });

  it("keeps an explicit zero instead of falling through to the global value", async () => {
    await expect(recordedPendingLimit({ historyLimit: 0 }, GLOBAL_CFG)).resolves.toBe(0);
  });
});
