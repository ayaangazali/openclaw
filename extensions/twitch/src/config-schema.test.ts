// Twitch tests cover config schema plugin behavior.
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
import { describe, expect, it } from "vitest";
import { TwitchConfigSchema } from "./config-schema.js";

function validateTwitchConfig(value: unknown): boolean {
  const schema = buildChannelConfigSchema(TwitchConfigSchema).schema;
  const result = validateJsonSchemaValue({
    cacheKey: "twitch.config-schema.test",
    schema,
    value,
  });
  if (!result.ok) {
    throw new Error(`expected valid Twitch config: ${JSON.stringify(result.errors)}`);
  }
  return true;
}

describe("TwitchConfigSchema JSON schema", () => {
  it("accepts single-account channel config with base fields", () => {
    expect(
      validateTwitchConfig({
        enabled: false,
        username: "openclaw",
        accessToken: "oauth:test",
        clientId: "test-client-id",
        channel: "openclaw-test",
      }),
    ).toBe(true);
  });

  it("accepts multi-account channel config with defaultAccount", () => {
    expect(
      validateTwitchConfig({
        enabled: true,
        defaultAccount: "stream",
        accounts: {
          stream: {
            username: "openclaw",
            accessToken: "oauth:test",
            clientId: "test-client-id",
            channel: "openclaw-test",
          },
        },
      }),
    ).toBe(true);
  });

  it("accepts the root historyLimit override in both union branches", () => {
    // Both branches are closed, so a key present in only one is rejected outright
    // for configs that can match the other.
    expect(
      validateTwitchConfig({
        historyLimit: 5,
        username: "openclaw",
        accessToken: "oauth:test",
        clientId: "test-client-id",
        channel: "openclaw-test",
      }),
    ).toBe(true);
    expect(
      validateTwitchConfig({
        historyLimit: 5,
        accounts: {
          stream: {
            username: "openclaw",
            accessToken: "oauth:test",
            clientId: "test-client-id",
            channel: "openclaw-test",
            historyLimit: 10,
          },
        },
      }),
    ).toBe(true);
  });
});
