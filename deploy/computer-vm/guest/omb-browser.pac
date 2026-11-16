function FindProxyForURL(url, host) {
  var closed = "PROXY 127.0.0.1:9";
  var upstream = "__OMB_UPSTREAM__";
  if (host == "posthog.com" || dnsDomainIs(host, ".posthog.com")) return closed;
  var extended = typeof dnsResolveEx == "function" && typeof isInNetEx == "function";
  var found = String((extended ? dnsResolveEx(host) : dnsResolve(host)) || "").split(";");
  var v4 = [
    ["127.0.0.0", "255.0.0.0"],
    ["0.0.0.0", "255.0.0.0"],
    ["10.0.0.0", "255.0.0.0"],
    ["172.16.0.0", "255.240.0.0"],
    ["192.168.0.0", "255.255.0.0"],
    ["169.254.0.0", "255.255.0.0"],
    ["100.64.0.0", "255.192.0.0"]
  ];
  var v6 = ["::1/128", "::/128", "::ffff:0:0/96", "fc00::/7", "fe80::/10", "fec0::/10"];
  var resolved = false;
  for (var a = 0; a < found.length; a++) {
    var address = found[a];
    if (!address) continue;
    resolved = true;
    if (address.indexOf(":") < 0) {
      for (var i = 0; i < v4.length; i++) {
        if (isInNet(address, v4[i][0], v4[i][1])) return closed;
      }
    } else if (extended) {
      for (var j = 0; j < v6.length; j++) {
        if (isInNetEx(address, v6[j])) return closed;
      }
    }
  }
  if (!resolved && upstream == "DIRECT") return closed;
  return upstream;
}
