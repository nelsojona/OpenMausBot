import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { pinnedRulesDigest } from "../../system-prompt.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents } from "../../testing/events.ts";
import { CustomAcpDriver } from "./custom.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");

describe("ACP pinned-rules digest", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
  });

  it("carries the pinned-rules digest on bare turns even when ACP compacts without a usage drop", async () => {
    ensureDirs();
    const dir = mkdtempSync(join(tmpdir(), "omb-acp-digest-"));
    cleanups.push(() => removeTempDir(dir));
    const dump = join(dir, "dump.json");
    const usageFile = join(dir, "usage.json");
    writeFileSync(usageFile, JSON.stringify([50_000]));

    const instance: ProviderInstance = await CustomAcpDriver.create({
      instanceId: "custom-digest-test",
      displayName: "Custom Digest",
      enabled: true,
      config: CustomAcpDriver.decodeConfig({ cli: `${process.execPath} --experimental-strip-types ${FAKE_CLI}` }),
      environment: {
        FAKE_ACP_DUMP: dump,
        FAKE_ACP_DUMP_PROMPT: "1",
        FAKE_ACP_USAGE_UPDATES_FILE: usageFile,
      },
    });
    cleanups.push(() => instance.adapter.stopAll?.());

    const events = recordEvents(instance.adapter);
    const soul = "Always cite sources.\nNever use emojis.";
    const memory = "- 2026-09-01 · rule · Reply in Spanish.";
    const digest = pinnedRulesDigest(soul, memory);
    const fullSystem = `${soul}\n\n${memory}`;

    const t1 = await instance.adapter.sendTurn({
      threadId: "thread-digest",
      botId: "bot-digest",
      text: "First question",
      system: fullSystem,
      systemStable: soul,
      systemVolatile: memory,
      pinnedRulesDigest: digest,
      cwd: dir,
    });
    await events.until((e) => e.type === "turn.completed" && e.turnId === t1.turnId);
    const firstBlocks = JSON.parse(readFileSync(`${dump}.prompt.json`, "utf8")) as Array<{ type: string; text?: string }>;
    const firstText = firstBlocks.map((b) => b.text ?? "").join("\n");
    expect(firstText).toContain("First question");

    // Steady usage (no drop below 60% peak) simulates a silent compaction that receipt tracking cannot detect.
    writeFileSync(usageFile, JSON.stringify([52_000]));
    const t2 = await instance.adapter.sendTurn({
      threadId: "thread-digest",
      botId: "bot-digest",
      text: "Second question",
      system: fullSystem,
      systemStable: soul,
      systemVolatile: memory,
      pinnedRulesDigest: digest,
      cwd: dir,
    });
    await events.until((e) => e.type === "turn.completed" && e.turnId === t2.turnId);

    const secondBlocks = JSON.parse(readFileSync(`${dump}.prompt.json`, "utf8")) as Array<{ type: string; text?: string }>;
    const secondText = secondBlocks.map((b) => b.text ?? "").join("\n");
    expect(secondText).toContain("Pinned standing rules (always follow):");
    expect(secondText).toContain("- Always cite sources.");
    expect(secondText).toContain("- Reply in Spanish.");
    expect(secondText).toContain("Second question");
  });
});
