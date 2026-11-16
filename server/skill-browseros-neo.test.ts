import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { offersSkillCommand, parseSkillCommand } from "../shared/skill-command.ts";
import { parseSkillMd, scanSkillText } from "../shared/skill-md.ts";
import { NEO_TOOL_LIST, NeoBrowserEngine } from "./browser/neo/engine.ts";
import { createSkillsLibraryHost } from "./host/skills-library.ts";
import { loadBundledSkills, selectBundledSkills } from "./skill-library.ts";
import type { BotRecord, Store } from "./store.ts";

describe("/browseros-neo bundled slash skill", () => {
  let tempDir: string;
  let proxyServer: Server | null = null;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "omb-skill-neo-"));
  });

  afterEach(async () => {
    if (proxyServer) {
      const s = proxyServer;
      proxyServer = null;
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("loads cleanly, passes scanSkillText with zero warnings, and puts the Neo routing guard before Steps", () => {
    const bundled = loadBundledSkills();
    const neo = bundled.find((skill) => skill.manifest.id === "browseros-neo");
    expect(neo).toBeDefined();
    expect(neo!.manifest.triggerTerms).toContain("/browseros-neo");

    const parsed = parseSkillMd(neo!.instructions);
    expect("error" in parsed).toBe(false);
    if ("error" in parsed) return;
    expect(parsed.name).toBe("browseros-neo");
    expect(scanSkillText(neo!.instructions)).toEqual([]);

    const guardIndex = neo!.instructions.indexOf("## First, every time: is this bot's browser Neo?");
    const stepsIndex = neo!.instructions.indexOf("## Steps");
    expect(guardIndex).toBeGreaterThan(-1);
    expect(stepsIndex).toBeGreaterThan(guardIndex);

    const guardSlice = neo!.instructions.slice(guardIndex, stepsIndex);
    expect(guardSlice).toContain("agent_browser_status");
    expect(guardSlice).toContain("Browser: BrowserOS neo");
  });

  it("agrees with NeoBrowserEngine status output and NEO_TOOL_LIST", async () => {
    const bundled = loadBundledSkills();
    const neo = bundled.find((skill) => skill.manifest.id === "browseros-neo")!;

    const neoToolNames = new Set<string>(NEO_TOOL_LIST.map((tool) => tool.name));
    const mentionedTools = [...new Set(neo.instructions.match(/\bagent_browser_[a-z_]+\b/g) ?? [])];
    const disabledByDesign = new Set(["agent_browser_eval", "agent_browser_upload"]);
    for (const tool of mentionedTools) {
      if (disabledByDesign.has(tool)) {
        expect(neoToolNames.has(tool)).toBe(false);
      } else {
        expect(neoToolNames.has(tool), `expected ${tool} in NEO_TOOL_LIST`).toBe(true);
      }
    }

    proxyServer = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, url: "https://example.com/", title: "Example Domain" }));
    });
    await new Promise<void>((resolve) => proxyServer!.listen(0, "127.0.0.1", resolve));
    const port = (proxyServer.address() as { port: number }).port;

    const engine = new NeoBrowserEngine({
      cfg: {
        features: { browserOsNeo: true },
        browserEngine: {
          engine: "browseros-neo",
          neo: { url: `http://127.0.0.1:${port}`, token: "c".repeat(32) },
        },
      },
      dataDir: tempDir,
      botOf: (id) => ({ id }),
    });

    const status = (await engine.agentRpc(
      { session: "bot-neo-1", botId: "bot-1" },
      "tools/call",
      { name: "agent_browser_status", arguments: {} },
    )) as { content: Array<{ type: string; text: string }> };

    const firstLine = status.content[0]!.text.split("\n")[0]!;
    expect(firstLine.startsWith("Browser: BrowserOS neo")).toBe(true);
  });

  it("offers /browseros-neo in Composer slash autocomplete and expands cleanly across CLI and API drivers", () => {
    const store = {
      bot: () => undefined,
      messagesFor: () => [],
      taskByThread: () => undefined,
    } as unknown as Store;
    const bot = {
      id: "bot-atlas-1",
      name: "Atlas",
      threadId: "main",
      modelSelection: { instanceId: "claude", model: "claude-sonnet-4-6" },
    } as BotRecord;
    const bundled = loadBundledSkills();
    const host = createSkillsLibraryHost({
      store,
      cfg: {},
      appendSkillRequestCard: () => ({ requestId: "req-1", summary: "ok" }),
      instanceOf: (instanceId) =>
        instanceId === "claude"
          ? { instanceId: "claude", driverKind: "claudeAgent" }
          : { instanceId: "openai", driverKind: "openai-compat" },
      bundledSlashSkills: () => bundled,
    });

    const skills = host.listBotSkills(bot);
    const skillNames = skills.map((s) => s.name);
    expect(skillNames).toContain("browseros-neo");
    expect(offersSkillCommand("browseros-neo")).toBe(true);
    expect(
      parseSkillCommand("/browseros-neo provider=openai model=gpt-5.4 Check https://example.com", skillNames),
    ).toEqual({
      name: "browseros-neo",
      request: "provider=openai model=gpt-5.4 Check https://example.com",
    });
    expect(host.readBotSkillFile(bot, "browseros-neo")).toContain("Browser: BrowserOS neo");

    const hostNoAuthoring = createSkillsLibraryHost({
      store,
      cfg: { features: { skillAuthoring: false } },
      appendSkillRequestCard: () => ({ requestId: "req-1", summary: "ok" }),
      instanceOf: () => ({ instanceId: "claude", driverKind: "claudeAgent" }),
      bundledSlashSkills: () => bundled,
    });
    expect(hostNoAuthoring.listBotSkills(bot).map((s) => s.name)).toEqual(["browseros-neo"]);

    const rawInput = "/browseros-neo provider=openai model=gpt-5.4 Check https://example.com";
    const cliExpanded = host.expandSkillCommand(
      bot,
      bot.threadId,
      rawInput,
      { instanceId: "claude", driverKind: "claudeAgent" },
      [],
      true,
    );
    expect(cliExpanded).toContain("The user ran your browseros-neo skill with /browseros-neo.");
    expect(cliExpanded).toContain("skills/browseros-neo/SKILL.md");
    expect(cliExpanded).toContain("Request: provider=openai model=gpt-5.4 Check https://example.com");
    expect(selectBundledSkills(cliExpanded, [], bundled).map((s) => s.manifest.id)).toContain("browseros-neo");

    const apiExpanded = host.expandSkillCommand(
      bot,
      bot.threadId,
      rawInput,
      { instanceId: "openai", driverKind: "openai-compat" },
      [],
      true,
    );
    expect(apiExpanded).toBe(rawInput);
    expect(selectBundledSkills(apiExpanded, [], bundled).map((s) => s.manifest.id)).toContain("browseros-neo");
  });
});
