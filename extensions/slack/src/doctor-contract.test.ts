import { describe, expect, it } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./doctor-contract.js";

describe("slack doctor contract", () => {
  it("removes retired interactive reply capabilities from root and account config", () => {
    const result = normalizeCompatibilityConfig({
      cfg: {
        channels: {
          slack: {
            capabilities: { interactiveReplies: true },
            accounts: {
              work: { capabilities: ["threads", " interactiveReplies "] },
            },
          },
        },
      } as never,
    });

    expect(result.config.channels?.slack).toEqual({
      accounts: { work: { capabilities: ["threads"] } },
    });
    expect(result.changes).toEqual([
      "Removed retired channels.slack.capabilities.interactiveReplies; use typed presentation actions instead.",
      "Removed retired channels.slack.accounts.work.capabilities.interactiveReplies; use typed presentation actions instead.",
    ]);
  });

  it("removes empty object-form capabilities accepted by the retired schema", () => {
    const result = normalizeCompatibilityConfig({
      cfg: {
        channels: {
          slack: {
            capabilities: {},
            accounts: { work: { capabilities: {} } },
          },
        },
      } as never,
    });

    expect(result.config.channels?.slack).toEqual({ accounts: { work: {} } });
    expect(result.changes).toEqual([
      "Removed retired empty channels.slack.capabilities object; use typed presentation actions instead.",
      "Removed retired empty channels.slack.accounts.work.capabilities object; use typed presentation actions instead.",
    ]);
  });

  it("moves direct DM reply mode to the chat-type map", () => {
    const result = normalizeCompatibilityConfig({
      cfg: {
        channels: {
          slack: {
            dm: { replyToMode: "all" },
            accounts: { work: { dm: { replyToMode: "first" } } },
          },
        },
      } as never,
    });
    expect(result.config.channels?.slack).toEqual({
      dm: {},
      replyToModeByChatType: { direct: "all" },
      accounts: {
        work: { dm: {}, replyToModeByChatType: { direct: "first" } },
      },
    });
  });
});

describe("retired Socket Mode transport tuning", () => {
  it("flags and strips socketMode at root and account scope", () => {
    const rootRule = legacyConfigRules.find(
      (rule) => rule.path.join(".") === "channels.slack" && rule.message?.includes("socketMode"),
    );
    const accountRule = legacyConfigRules.find(
      (rule) =>
        rule.path.join(".") === "channels.slack.accounts" && rule.message?.includes("socketMode"),
    );
    expect(rootRule?.match?.({ socketMode: { clientPingTimeout: 20000 } }, {})).toBe(true);
    expect(rootRule?.match?.({ mode: "socket" }, {})).toBe(false);
    expect(accountRule?.match?.({ ops: { socketMode: { serverPingTimeout: 30000 } } }, {})).toBe(
      true,
    );

    const result = normalizeCompatibilityConfig({
      cfg: {
        channels: {
          slack: {
            mode: "socket",
            socketMode: { clientPingTimeout: 20000, pingPongLoggingEnabled: false },
            accounts: { ops: { socketMode: { serverPingTimeout: 30000 } } },
          },
        },
      } as never,
    });

    const slack = (result.config.channels as Record<string, Record<string, unknown>>).slack;
    expect(slack.socketMode).toBeUndefined();
    expect(slack.mode).toBe("socket");
    const accounts = slack.accounts as Record<string, Record<string, unknown>>;
    expect(accounts.ops?.socketMode).toBeUndefined();
    expect(result.changes.some((change) => change.includes("socketMode"))).toBe(true);
  });

  it("leaves a Slack config without the retired object untouched", () => {
    const result = normalizeCompatibilityConfig({
      cfg: { channels: { slack: { mode: "socket" } } } as never,
    });
    expect(result.changes.some((change) => change.includes("socketMode"))).toBe(false);
  });
});
