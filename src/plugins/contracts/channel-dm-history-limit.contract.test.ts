// Verifies DM-capable channels accept the documented dmHistoryLimit override.
import { describe, expect, it } from "vitest";
import { GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA } from "../../config/bundled-channel-config-metadata.generated.js";

type JsonSchemaLike = {
  properties?: Record<string, unknown>;
  additionalProperties?: unknown;
};

function asSchema(value: unknown): JsonSchemaLike | undefined {
  return value && typeof value === "object" ? (value as JsonSchemaLike) : undefined;
}

/** A closed schema without the key is what makes config loading fail. */
function rejectsKey(schema: JsonSchemaLike | undefined, key: string): boolean {
  if (!schema || schema.additionalProperties !== false) {
    return false;
  }
  return !Object.hasOwn(schema.properties ?? {}, key);
}

/**
 * docs/gateway/config-channels.md states the DM history resolver reads
 * channels.<provider>.dmHistoryLimit for any channel with provider:direct:<id>
 * sessions, "not just a fixed list", so every channel exposing a DM policy has
 * to accept the key. Channels without a DM surface are out of scope.
 */
const dmCapableChannels = GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.filter((entry) =>
  Object.hasOwn(asSchema(entry.schema)?.properties ?? {}, "dmPolicy"),
).map((entry) => entry.channelId);

describe("channel dmHistoryLimit contract", () => {
  it("finds DM-capable bundled channels", () => {
    expect(dmCapableChannels.length).toBeGreaterThan(0);
  });

  it.each(dmCapableChannels)("%s accepts channels.<id>.dmHistoryLimit", (channelId) => {
    const entry = GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.find(
      (candidate) => candidate.channelId === channelId,
    );
    expect(rejectsKey(asSchema(entry?.schema), "dmHistoryLimit")).toBe(false);
  });

  it.each(dmCapableChannels)(
    "%s accepts channels.<id>.accounts.<account>.dmHistoryLimit",
    (channelId) => {
      const entry = GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.find(
        (candidate) => candidate.channelId === channelId,
      );
      const accounts = asSchema(asSchema(entry?.schema)?.properties?.accounts);
      expect(rejectsKey(asSchema(accounts?.additionalProperties), "dmHistoryLimit")).toBe(false);
    },
  );
});
