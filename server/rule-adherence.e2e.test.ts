import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

interface ProbeResult {
  stage: string;
  rule: string;
  present: boolean;
}

it("retains soul rules, rule-kind memory entries, and chat directives across turn 1, compaction, memory upkeep, and fresh sessions", async () => {
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "happy" });
  const api = async (method: string, path: string, body?: unknown, expected = 200) => {
    const response = await fetch(fixture.info.url + path, {
      method,
      headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(result)}`).toBe(expected);
    return result;
  };
  const control = (...args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
  const readDump = () => JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")) as {
    systemPromptFile?: string;
    prompt?: unknown;
  };
  const dumpText = (dump: { systemPromptFile?: string; prompt?: unknown }) =>
    `${dump.systemPromptFile ?? ""}\n${JSON.stringify(dump.prompt ?? "")}`;
  const sendAndWait = async (botId: string, threadId: string, text: string, allowOpenCard = false) => {
    await control("send", "--bot", botId, "--task", threadId, "--text", text);
    const waited = await control("wait", "--bot", botId, "--task", threadId, "--timeout", "20");
    if (allowOpenCard) expect(["settled", "needs-user"]).toContain(waited.status);
    else expect(waited.status).toBe("settled");
    return readDump();
  };

  const results: ProbeResult[] = [];
  const check = (stage: string, rule: string, haystack: string) => {
    const present = haystack.includes(rule);
    results.push({ stage, rule, present });
    expect(present, `${stage}: missing rule "${rule}"`).toBe(true);
  };

  let restarted: ChildProcess | undefined;
  const restartWith = async (mutateConfig?: (cfg: Record<string, any>) => void) => {
    await waitForExit(restarted ?? fixture.child, { signal: "SIGTERM" });
    if (mutateConfig) {
      const cfgPath = join(fixture.info.dataDir, "config.json");
      const cfgJson = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, any>;
      mutateConfig(cfgJson);
      writeFileSync(cfgPath, JSON.stringify(cfgJson));
    }
    const log = openSync(fixture.info.logPath, "a", 0o600);
    restarted = spawn(process.execPath, ["--experimental-strip-types", "server/index.ts"], {
      cwd: process.cwd(),
      env: verificationServerEnvironment({ FAKE_CLAUDE_MODE: "happy" }, fixture.info.dataDir, Number(new URL(fixture.info.url).port)),
      stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(`${fixture.info.url}/api/health`, { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
    }, { timeout: 20_000 }).toBe(true);
  };

  try {
    const soulRule = "Always end status updates with [VERIFIED].";
    const memoryRule = "The person wants all dates in ISO-8601 format.";
    const chatDirective = "From now on, never use exclamation marks in reports.";

    const created = await api("POST", "/api/bots", { name: "Rule Probe" }, 201);
    const bot = created.bot as { id: string; threadId: string };
    await api("PATCH", `/api/bots/${bot.id}`, { soul: soulRule });

    // Seed MEMORY.md with an explicit `rule` entry plus facts.
    const seededMemory = [
      `# Memory`,
      `- 2026-09-01 · rule · ${memoryRule}`,
      `- 2026-09-02 · Project codename is Lantern.`,
      `- 2026-09-03 · Weekly sync is on Tuesday.`,
    ].join("\n") + "\n";
    await api("PUT", `/api/bots/${bot.id}/memory/file`, { path: "MEMORY.md", text: seededMemory });

    // Stage 1: Turn 1 probe.
    const dump1 = await sendAndWait(bot.id, bot.threadId, "Probe 1: status update.");
    const prompt1 = dumpText(dump1);
    check("turn-1", soulRule, prompt1);
    check("turn-1", memoryRule, prompt1);

    // Stage 2: Restart with DISABLE_COMPACT so OpenMausBot's fold runs, give a chat directive, force compaction, then probe.
    await restartWith((cfg) => {
      cfg.instances.claude.environment = { ...cfg.instances.claude.environment, DISABLE_COMPACT: "1" };
    });
    await sendAndWait(bot.id, bot.threadId, chatDirective);
    await sendAndWait(bot.id, bot.threadId, "Filler turn 1: discussing quarterly roadmap.");
    await sendAndWait(bot.id, bot.threadId, "Filler turn 2: reviewing sprint metrics.");
    await api("POST", `/api/bots/${bot.id}/compact`, { threadId: bot.threadId }, 202);

    type MsgRow = {
      kind: string;
      engineCompaction?: boolean;
      card?: { tool?: string; options?: string[]; subtitle?: string };
      compaction?: { summary?: string; directives?: string[] };
    };
    let messagesAfterCompact: MsgRow[] = [];
    await expect.poll(async () => {
      messagesAfterCompact = (await api("GET", `/api/threads/${bot.threadId}/messages`)).messages as MsgRow[];
      return messagesAfterCompact.some((m) => m.kind === "compaction");
    }, { timeout: 15_000 }).toBe(true);
    const compactionMsg = messagesAfterCompact.find((m) => m.kind === "compaction");
    expect(compactionMsg?.compaction?.directives, JSON.stringify(compactionMsg)).toContain(chatDirective);
    const saveCard = messagesAfterCompact.find((m) => m.kind === "options" && m.card?.tool === "update_profile");
    expect(saveCard?.card?.options).toEqual(["Confirm", "Cancel"]);
    expect(saveCard?.card?.subtitle).toContain(chatDirective);

    const dump2 = await sendAndWait(bot.id, bot.threadId, "Probe 2: post-compaction status report.", true);
    const prompt2 = dumpText(dump2);
    check("post-compaction", soulRule, prompt2);
    check("post-compaction", memoryRule, prompt2);
    check("post-compaction", chatDirective, prompt2);

    // Stage 3: Memory upkeep tidy-up cycle, then probe.
    await api("POST", `/api/bots/${bot.id}/memory/tidy`, {});
    const dump3 = await sendAndWait(bot.id, bot.threadId, "Probe 3: post-tidy status report.", true);
    const prompt3 = dumpText(dump3);
    check("post-upkeep", soulRule, prompt3);
    // MEMORY.md did not change after tidy, so check both disk persistence and the fresh session below.
    const afterTidy = (await api("GET", `/api/bots/${bot.id}/memory/file?path=MEMORY.md`)).text as string;
    check("post-upkeep-memory", memoryRule, afterTidy);

    // Stage 4: Fresh conversation (simulates restart / new session), then probe.
    const freshTask = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Fresh probe" }, 201)).task as { threadId: string };
    const dump4 = await sendAndWait(bot.id, freshTask.threadId, "Probe 4: fresh conversation status report.");
    const prompt4 = dumpText(dump4);
    check("fresh-session", soulRule, prompt4);
    check("fresh-session", memoryRule, prompt4);

    expect(results.every((r) => r.present)).toBe(true);
  } finally {
    if (restarted) await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
  }
}, 90_000);
