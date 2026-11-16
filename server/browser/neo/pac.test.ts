import { readFileSync } from "node:fs";
import net from "node:net";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const PAC_TEMPLATE = readFileSync(
  new URL("../../../deploy/computer-vm/guest/omb-browser.pac", import.meta.url),
  "utf8",
);

function ipv4Int(ip: string): number {
  const parts = ip.split(".").map(Number);
  return (((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0);
}

function expandIpv6(raw: string): number[] | undefined {
  const v4Match = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(raw);
  let addr = raw.toLowerCase();
  if (v4Match) {
    const num = ipv4Int(v4Match[2]!);
    addr = `${v4Match[1]}${((num >>> 16) & 0xffff).toString(16)}:${(num & 0xffff).toString(16)}`;
  }
  if (!net.isIPv6(addr)) return undefined;
  const halves = addr.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":").map((part) => parseInt(part, 16)) : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":").map((part) => parseInt(part, 16)) : [];
  const fill = 8 - left.length - right.length;
  if (fill < 0) return undefined;
  return [...left, ...Array<number>(fill).fill(0), ...right];
}

function isInNetExImpl(ip: string, cidr: string): boolean {
  const [prefixAddr, bitsRaw] = cidr.split("/");
  const bits = Number(bitsRaw);
  const a = expandIpv6(ip);
  const b = expandIpv6(prefixAddr ?? "");
  if (!a || !b || !Number.isInteger(bits)) return false;
  let remaining = bits;
  for (let i = 0; i < 8 && remaining > 0; i++) {
    const take = Math.min(16, remaining);
    const mask = take === 16 ? 0xffff : ((0xffff << (16 - take)) & 0xffff);
    if ((a[i]! & mask) !== (b[i]! & mask)) return false;
    remaining -= take;
  }
  return true;
}

function loadPac(upstream: string, records: Record<string, string[]>) {
  const source = PAC_TEMPLATE.replace("__OMB_UPSTREAM__", upstream);
  const sandbox = {
    dnsDomainIs(host: string, domain: string) {
      return host.toLowerCase().endsWith(domain.toLowerCase());
    },
    dnsResolve(host: string) {
      if (net.isIPv4(host)) return host;
      return records[host]?.find((ip) => net.isIPv4(ip)) ?? "";
    },
    dnsResolveEx(host: string) {
      if (net.isIP(host)) return host;
      return (records[host] ?? []).join(";");
    },
    isInNet(ip: string, pattern: string, mask: string) {
      if (!net.isIPv4(ip)) return false;
      return (ipv4Int(ip) & ipv4Int(mask)) === (ipv4Int(pattern) & ipv4Int(mask));
    },
    isInNetEx: isInNetExImpl,
    FindProxyForURL: undefined as unknown as (url: string, host: string) => string,
  };
  vm.runInNewContext(source, sandbox);
  return sandbox.FindProxyForURL;
}

describe("omb-browser.pac", () => {
  it("sends PostHog telemetry domains to a closed loopback port", () => {
    const find = loadPac("DIRECT", { "posthog.com": ["93.184.216.34"], "us.i.posthog.com": ["93.184.216.34"] });
    expect(find("https://posthog.com/decide", "posthog.com")).toBe("PROXY 127.0.0.1:9");
    expect(find("https://us.i.posthog.com/e/", "us.i.posthog.com")).toBe("PROXY 127.0.0.1:9");
    expect(find("https://eu.i.posthog.com/batch/", "eu.i.posthog.com")).toBe("PROXY 127.0.0.1:9");
  });

  it("blocks hosts resolving to private, loopback, link-local, CGNAT, or IPv6 local ranges", () => {
    const find = loadPac("DIRECT", {
      "loop.example": ["127.0.0.1"],
      "ten.example": ["10.4.2.1"],
      "rfc1918.example": ["172.20.0.9"],
      "home.example": ["192.168.1.50"],
      "meta.example": ["169.254.169.254"],
      "tailnet.example": ["100.100.100.100"],
      "zero.example": ["0.0.0.0"],
      "v6loop.example": ["::1"],
      "v6ula.example": ["fd12:3456::1"],
      "v6ll.example": ["fe80::1"],
      "v4mapped.example": ["::ffff:127.0.0.1"],
      "split.example": ["93.184.216.34", "10.0.0.8"],
    });
    for (const host of [
      "loop.example",
      "ten.example",
      "rfc1918.example",
      "home.example",
      "meta.example",
      "tailnet.example",
      "zero.example",
      "v6loop.example",
      "v6ula.example",
      "v6ll.example",
      "v4mapped.example",
      "split.example",
    ]) {
      expect(find(`https://${host}/`, host), host).toBe("PROXY 127.0.0.1:9");
    }
  });

  it("allows public IPv4 and IPv6 targets and fails closed on unresolved DNS in DIRECT mode", () => {
    const direct = loadPac("DIRECT", {
      "example.com": ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"],
    });
    expect(direct("https://example.com/", "example.com")).toBe("DIRECT");
    expect(direct("https://unresolved.example/", "unresolved.example")).toBe("PROXY 127.0.0.1:9");

    const proxied = loadPac("PROXY 10.0.2.2:8118", {});
    expect(proxied("https://example.com/", "example.com")).toBe("PROXY 10.0.2.2:8118");
    expect(proxied("https://us.i.posthog.com/e/", "us.i.posthog.com")).toBe("PROXY 127.0.0.1:9");
  });
});
