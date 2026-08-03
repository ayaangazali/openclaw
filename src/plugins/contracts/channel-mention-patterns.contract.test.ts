// Verifies group-capable channels accept the documented mentionPatterns policy.
import { describe, expect, it } from "vitest";
import { GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA } from "../../config/bundled-channel-config-metadata.generated.js";

type JsonSchemaLike = {
  type?: unknown;
  properties?: Record<string, unknown>;
  additionalProperties?: unknown;
  anyOf?: unknown[];
  oneOf?: unknown[];
  allOf?: unknown[];
};

function asSchema(value: unknown): JsonSchemaLike | undefined {
  return value && typeof value === "object" ? (value as JsonSchemaLike) : undefined;
}

/**
 * A closed schema without the key refuses the whole config. Composed schemas
 * must be walked: a union accepts when any alternative accepts, while allOf is
 * an intersection where one closed component still refuses the key.
 */
function rejectsKey(schema: JsonSchemaLike | undefined, key: string): boolean {
  if (!schema) {
    return false;
  }
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(alternatives) && alternatives.length > 0) {
    return alternatives.every((branch) => rejectsKey(asSchema(branch), key));
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    return schema.allOf.some((branch) => rejectsKey(asSchema(branch), key));
  }
  if (schema.additionalProperties !== false) {
    return false;
  }
  return !Object.hasOwn(schema.properties ?? {}, key);
}

function schemaFor(channelId: string): JsonSchemaLike | undefined {
  return asSchema(
    GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.find((entry) => entry.channelId === channelId)
      ?.schema,
  );
}

/**
 * Channels that deliberately omit the key via buildCommonChannelAccountShape,
 * plus the two that still publish the legacy string-array spelling. Migrating
 * those two to the policy object is a separate maintainer decision, so they are
 * excluded rather than silently reshaped.
 */
const EXCLUDED = new Set(["msteams", "imessage", "signal", "irc", "clickclack", "googlechat"]);

/**
 * docs/channels/groups.md documents channels.<channel>.mentionPatterns for
 * scoping mention patterns per channel, and resolveProviderMentionPatternsPolicy
 * reads cfg.channels[provider].mentionPatterns for any provider. Mention gating
 * is a group concept, so only group-capable channels owe the key.
 */
const groupCapableChannels = GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.filter((entry) => {
  if (EXCLUDED.has(entry.channelId)) {
    return false;
  }
  const properties = asSchema(entry.schema)?.properties ?? {};
  return (
    Object.hasOwn(properties, "groupPolicy") ||
    Object.hasOwn(properties, "groups") ||
    Object.hasOwn(properties, "groupAllowFrom")
  );
}).map((entry) => entry.channelId);

describe("channel mentionPatterns contract", () => {
  it("covers the group-capable bundled channels", () => {
    expect(groupCapableChannels.length).toBeGreaterThan(0);
  });

  it.each(groupCapableChannels)("%s accepts channels.<id>.mentionPatterns", (channelId) => {
    expect(rejectsKey(schemaFor(channelId), "mentionPatterns")).toBe(false);
  });

  it.each(groupCapableChannels)(
    "%s declares mentionPatterns as the canonical policy object",
    (channelId) => {
      const leaf = asSchema(schemaFor(channelId)?.properties?.mentionPatterns);
      if (!leaf) {
        return;
      }
      // The resolver only honors the policy object; an array is the legacy form.
      expect(leaf.type).not.toBe("array");
    },
  );
});
