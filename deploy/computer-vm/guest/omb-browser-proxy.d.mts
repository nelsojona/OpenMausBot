import type http from "node:http";

export const PROXY_VERSION: string;

export interface ProxyElement {
  ref: string;
  role: string;
  name: string;
  value?: string;
}

export function unwrapPageContent(text: string): string;
export function savedTextPath(text: string): string | undefined;
export function unwrapSavedText(raw: string): string;
export function parseSnapshot(tree: string): { elements: ProxyElement[]; conflicts: number };
export function parseElements(tree: string): ProxyElement[];
export function formatTree(elements: ProxyElement[]): string;
export function normalizeRef(ref: unknown): string | undefined;
export function parseTabLine(listing: string, page: number | undefined): { url: string; title: string } | undefined;
export function localAddress(hostname: string): boolean;
export function pdfFileName(title: string | undefined, url: string): string;
export function validateCommand(body: unknown): Record<string, unknown>;

export interface CreateProxyOptions {
  upstream: string;
  token: string;
  audit?: (entry: Record<string, unknown>) => Promise<unknown>;
  fetchImpl?: typeof fetch;
  outputRoot?: string;
  callTimeoutMs?: number;
  deadlineMs?: number;
  maxSessions?: number;
  maxPdfBytes?: number;
  now?: () => number;
  frontTab?: boolean;
  onActive?: () => void;
  onIdle?: () => void;
  idleMs?: number;
}

export function createProxy(options: CreateProxyOptions): {
  server: http.Server;
  sessions: Map<string, unknown>;
  sweep: () => Promise<void>;
};
