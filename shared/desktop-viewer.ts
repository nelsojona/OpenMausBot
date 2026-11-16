// The names the desktop proxy (`/api/desktop-viewer/<target>`) serves: one rule for the server and the renderer.

/** A Local VM is `local/shared`, `local/neo`, `local/bot-<sha256>` or `local/pool-<seat>`; a bot's VPS is `vps/<botId>`. */
export const DESKTOP_VIEWER_TARGET = /^(local\/(?:shared|neo|bot-[a-f0-9]{64}|pool-\d+)|vps\/[\w-]+)$/;

/** A Local VM's proxy name, from its target key (`shared`, `neo`, `bot:<sha256>` or `pool:<seat>`). */
export const viewerTargetId = (target: { key: string }) => `local/${target.key.replace(":", "-")}`;
