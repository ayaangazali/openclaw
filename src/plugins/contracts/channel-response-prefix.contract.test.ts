// Verifies every bundled channel accepts the documented responsePrefix override.
import { describe, expect, it } from "vitest";
import { GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA } from "../../config/bundled-channel-config-metadata.generated.js";

type JsonSchemaLike = {
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
 * must be walked, and a union counts as rejecting when ANY alternative rejects:
 * each alternative is a configuration mode an operator can choose, so a key
 * missing from one mode is unusable in that mode even though the union as a
 * whole would still validate. allOf is an intersection, where one closed
 * component refusing the key refuses the whole.
 */
function rejectsKey(schema: JsonSchemaLike | undefined, key: string): boolean {
  if (!schema) {
    return false;
  }
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(alternatives) && alternatives.length > 0) {
    return alternatives.some((branch) => rejectsKey(asSchema(branch), key));
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    return schema.allOf.some((branch) => rejectsKey(asSchema(branch), key));
  }
  if (schema.additionalProperties !== false) {
    return false;
  }
  return !Object.hasOwn(schema.properties ?? {}, key);
}

/** Account schemas across every composed branch, so unions and allOf are not skipped. */
function accountSchemasOf(schema: JsonSchemaLike | undefined): JsonSchemaLike[] {
  if (!schema) {
    return [];
  }
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(alternatives) && alternatives.length > 0) {
    return alternatives.flatMap((branch) => accountSchemasOf(asSchema(branch)));
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    return schema.allOf.flatMap((branch) => accountSchemasOf(asSchema(branch)));
  }
  const account = asSchema(asSchema(schema.properties?.accounts)?.additionalProperties);
  return account ? [account] : [];
}

/**
 * docs/concepts/messages.md documents channels.<channel>.responsePrefix and the
 * per-account form, and `resolveResponsePrefix` in src/agents/identity.ts reads
 * it. Applying it to an outbound reply is per-channel wiring rather than a
 * shared step, so the contract is anchored to the channels that actually
 * consume the prefix: offering the key elsewhere validates a setting the
 * delivery path would ignore.
 */
const PREFIX_CAPABLE_CHANNELS = [
  "clickclack",
  "feishu",
  "irc",
  "line",
  "matrix",
  "mattermost",
  "nextcloud-talk",
  "tlon",
  "twitch",
  "whatsapp",
  "zalo",
  "zalouser",
];

function schemaFor(channelId: string): JsonSchemaLike | undefined {
  return asSchema(
    GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.find((entry) => entry.channelId === channelId)
      ?.schema,
  );
}

const knownChannels = new Set(
  GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.map((entry) => entry.channelId),
);
const prefixChannels = PREFIX_CAPABLE_CHANNELS.filter((channelId) => knownChannels.has(channelId));

describe("channel responsePrefix contract", () => {
  it("covers the prefix-capable bundled channels", () => {
    expect(prefixChannels).toEqual(PREFIX_CAPABLE_CHANNELS);
  });

  it.each(prefixChannels)("%s accepts channels.<id>.responsePrefix", (channelId) => {
    expect(rejectsKey(schemaFor(channelId), "responsePrefix")).toBe(false);
  });

  it.each(prefixChannels)(
    "%s accepts channels.<id>.accounts.<account>.responsePrefix",
    (channelId) => {
      for (const account of accountSchemasOf(schemaFor(channelId))) {
        // rejectsKey answers false for an open schema too, so acceptance only
        // proves something once the account schema is closed.
        if (account.additionalProperties !== false) {
          continue;
        }
        expect(rejectsKey(account, "responsePrefix")).toBe(false);
      }
    },
  );
});
