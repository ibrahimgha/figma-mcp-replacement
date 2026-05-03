export interface FrameCandidateForFilter {
  name: string;
  pageName?: string;
  layerKind?: string;
}

export function skipReasonForLeftSection(name: string): string | undefined {
  const normalized = normalizeName(name);
  if (/^cover$/i.test(normalized)) return "cover page is not an app screen";
  if (/^overview$/i.test(normalized)) return "overview page is not an app screen";
  return undefined;
}

export function skipReasonForFrameCandidate(candidate: FrameCandidateForFilter): string | undefined {
  const name = normalizeName(candidate.name);
  const pageName = candidate.pageName ? normalizeName(candidate.pageName) : "";

  if (!name) return "empty frame name";
  if (/^(screen label|section label)(?:\b|$)/i.test(name)) return "label-only frame";
  if (/^cover$/i.test(name) && /^cover$/i.test(pageName)) return "cover page frame";
  if (/^frame\s+\d+$/i.test(name)) return "generic numbered frame";
  if (/^iphone\s+\d/i.test(name)) return "device mock frame";
  if (/^\d{5,}_[\d\s]+(?:\d+)?$/i.test(name)) return "raw imported image frame";
  if (/^(pointer|top|container)$/i.test(name)) return "utility layer frame";

  return undefined;
}

function normalizeName(value: string): string {
  return value
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/\s+(?:Edited|Created)\b.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}
