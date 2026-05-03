import type { FrameRecord } from "./types";

export type ReviewCommand =
  | { action: "accept" }
  | { action: "cancel" }
  | { action: "add" }
  | { action: "remove"; indexes: number[] }
  | { action: "unknown"; raw: string };

export function parseReviewCommand(raw: string): ReviewCommand {
  const trimmed = raw.trim();
  if (!trimmed) return { action: "accept" };
  if (/^(q|quit|cancel|exit)$/i.test(trimmed)) return { action: "cancel" };
  if (/^(a|add|\+)$/i.test(trimmed)) return { action: "add" };

  const removeMatch = /^(r|remove|-)\s+(.+)$/i.exec(trimmed);
  if (removeMatch) {
    const indexes = removeMatch[2]
      .split(/[,\s]+/)
      .map((part) => Number.parseInt(part, 10))
      .filter((value) => Number.isInteger(value) && value > 0);
    return { action: "remove", indexes };
  }

  return { action: "unknown", raw: trimmed };
}

export function dedupeFrames(frames: FrameRecord[]): FrameRecord[] {
  const seen = new Set<string>();
  const result: FrameRecord[] = [];
  for (const frame of frames) {
    const key = frame.nodeId || `${frame.name}:${frame.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(frame);
  }
  return result;
}

export function removeFramesByOneBasedIndexes(
  frames: FrameRecord[],
  indexes: number[],
): FrameRecord[] {
  const toRemove = new Set(indexes.map((index) => index - 1));
  return frames.filter((_, index) => !toRemove.has(index));
}
