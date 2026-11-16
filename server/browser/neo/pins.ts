export type NeoArch = "x86_64" | "aarch64";

export interface NeoArtifactPin {
  readonly url: string;
  readonly sha256: string;
  readonly size: number;
}

export const BROWSEROS_NEO_PIN: {
  readonly version: string;
  readonly release: string;
  readonly license: string;
  readonly x86_64: NeoArtifactPin;
  readonly aarch64: NeoArtifactPin;
} = {
  version: "0.52.1.1",
  release: "https://github.com/browseros-ai/BrowserOS/releases/tag/browserclaw/v0.52.0",
  license: "AGPL-3.0",
  x86_64: {
    url: "https://github.com/browseros-ai/BrowserOS/releases/download/browserclaw/v0.52.0/BrowserOS_neo_v0.52.1.1_x64.AppImage",
    sha256: "c62c050c1fd676287b11b203294ab05c8ee6ad8aefa2369aadbda0b37e1a1379",
    size: 223_488_504,
  },
  aarch64: {
    url: "https://github.com/browseros-ai/BrowserOS/releases/download/browserclaw/v0.52.0/BrowserOS_neo_v0.52.1.1_arm64.AppImage",
    sha256: "8ffbfbe0395c7c9e0c9becce12cb48d13d0c78c60c5c8247d3dfa982ae75ec53",
    size: 210_987_528,
  },
};
