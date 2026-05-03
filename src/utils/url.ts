export interface ParsedFigmaUrl {
  url: URL;
  fileKey?: string;
  fileSlug: string;
  nodeId?: string;
}

export function normalizeNodeId(value: string): string {
  return decodeURIComponent(value).trim().replace(/-/g, ":");
}

export function nodeIdToUrlParam(nodeId: string): string {
  return nodeId.trim().replace(/:/g, "-");
}

export function parseFigmaUrl(input: string): ParsedFigmaUrl {
  const url = new URL(input);
  const pathParts = url.pathname.split("/").filter(Boolean);
  const fileKindIndex = pathParts.findIndex((part) =>
    ["design", "file", "proto", "make"].includes(part),
  );
  const fileKey = fileKindIndex >= 0 ? pathParts[fileKindIndex + 1] : undefined;
  const namePart = fileKindIndex >= 0 ? pathParts[fileKindIndex + 2] : undefined;
  const nodeIdParam = url.searchParams.get("node-id") ?? undefined;

  return {
    url,
    fileKey,
    fileSlug: namePart ? decodeURIComponent(namePart) : fileKey ?? "figma-file",
    nodeId: nodeIdParam ? normalizeNodeId(nodeIdParam) : undefined,
  };
}

export function withNodeId(input: string, nodeId: string): string {
  const url = new URL(input);
  url.searchParams.set("node-id", nodeIdToUrlParam(nodeId));
  return url.toString();
}

export function readNodeIdFromUrl(input: string): string | undefined {
  const url = new URL(input);
  const nodeId = url.searchParams.get("node-id");
  return nodeId ? normalizeNodeId(nodeId) : undefined;
}
