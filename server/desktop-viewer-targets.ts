import { viewerTargetId } from "../shared/desktop-viewer.ts";
import { neoDesktopTarget, neoViewerLease, type NeoScreenBotInput } from "./browser/neo/vm-screen.ts";
import { localVmMaxInstances, type AppConfig } from "./config.ts";
import {
  perBotLocalVmTarget,
  poolLocalVmTarget,
  SHARED_LOCAL_VM_TARGET,
  type ContainerComputerStatus,
  type LocalVmTarget,
} from "./container-computer.ts";
import type { RequestAuth } from "./request-auth.ts";
import { desktopViewerUrl, type DesktopConnection, type DesktopTarget } from "./routes/desktop-viewer.ts";

/** Native owner windows keep the existing direct viewer and cookie isolation; raw RFB targets always use `/desktop-viewer`. */
export function localVmViewerStatus<T extends { target_key: string; viewer_url: string }>(status: T, auth: RequestAuth): T {
  return auth.kind === "loopback" && status.target_key !== "neo" ? status : {
    ...status,
    viewer_url: status.viewer_url ? desktopViewerUrl(viewerTargetId({ key: status.target_key })) : "",
  };
}

export function localDesktopTarget(target: LocalVmTarget, deps: {
  status: (target: LocalVmTarget) => Promise<ContainerComputerStatus>;
  touch: (target: LocalVmTarget) => void;
}): DesktopTarget {
  return {
    key: target.key,
    async resolve() {
      const status = await deps.status(target);
      if (!status.managed || !status.imageMatches || status.network !== "loopback" || status.container !== "running"
        || !status.viewer_url) {
        throw Object.assign(new Error("Local VM unavailable"), { status: 409 });
      }
      return {
        port: status.viewer_port ?? 0,
        password: new URLSearchParams(new URL(status.viewer_url).hash.slice(1)).get("password"),
        touch: () => deps.touch(target),
      };
    },
  };
}

export function resolveDesktopViewerTarget<TBot extends NeoScreenBotInput & { id: string; cloudBackend?: string }>(
  id: string,
  deps: {
    cfg: () => AppConfig;
    dataDir: string;
    bots: () => readonly TBot[];
    bot: (botId: string) => TBot | null | undefined;
    vpsConnection: (botId: string) => DesktopConnection | null | undefined;
    status: (target: LocalVmTarget) => Promise<ContainerComputerStatus>;
    touch: (target: LocalVmTarget) => void;
  },
): DesktopTarget | undefined {
  if (id === "local/neo") return neoDesktopTarget(deps.cfg, deps.dataDir, deps.bots);
  if (id.startsWith("vps/")) {
    const botId = id.slice(4);
    if (deps.bot(botId)?.cloudBackend !== "vps") return;
    return {
      key: id,
      resolve: async () => {
        const connection = deps.vpsConnection(botId);
        if (!connection) throw Object.assign(new Error("VPS viewer is not open"), { status: 409 });
        return connection;
      },
    };
  }
  const targets = [
    SHARED_LOCAL_VM_TARGET,
    ...deps.bots().map((bot) => perBotLocalVmTarget(bot.id)),
    ...Array.from({ length: localVmMaxInstances(deps.cfg()) }, (_, seat) => poolLocalVmTarget(seat)),
  ];
  const target = targets.find((candidate) => viewerTargetId(candidate) === id);
  return target && localDesktopTarget(target, { status: deps.status, touch: deps.touch });
}

export function resolveDesktopViewerLease<TBot extends NeoScreenBotInput & { id: string }>(
  id: string,
  botId: string,
  controlLeaseId: string,
  threadId: string | undefined,
  deps: {
    cfg: AppConfig;
    dataDir: string;
    bot: (botId: string) => TBot | null | undefined;
    targetForStatus: (botId: string, threadId?: string) => { key: string };
    leaseKey: (bot: TBot, threadId?: string) => string;
    beat: (key: string, leaseId: string) => boolean;
  },
): (() => boolean) | undefined {
  const bot = deps.bot(botId);
  if (bot && id === "local/neo") {
    return neoViewerLease(bot, deps.cfg, deps.dataDir, deps.leaseKey(bot, threadId), controlLeaseId, deps.beat);
  }
  if (!bot || viewerTargetId(deps.targetForStatus(bot.id, threadId)) !== id) return;
  const key = deps.leaseKey(bot, threadId);
  const holds = () => deps.beat(key, controlLeaseId);
  return holds() ? holds : undefined;
}
