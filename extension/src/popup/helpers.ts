const ROOM_CODE_PATTERN = /^\d{4}$/;

export function escapeHtml(value: unknown): string {
  const normalized =
    typeof value === "string" ? value : value == null ? "" : String(value);
  return normalized
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function parseInviteValue(
  value: string,
): { roomCode: string; joinToken: string } | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed.replace(/\s+/g, "");

  // 4-digit numeric room code — no joinToken needed (public join)
  if (ROOM_CODE_PATTERN.test(normalized)) {
    return { roomCode: normalized, joinToken: "" };
  }

  // Backward compat: full "roomCode:joinToken" format
  const separators = [":", "|", ","];
  for (const separator of separators) {
    const [roomCode, joinToken, ...rest] = normalized.split(separator);
    if (!roomCode || !joinToken || rest.length > 0) {
      continue;
    }
    if (!ROOM_CODE_PATTERN.test(roomCode)) {
      continue;
    }
    return { roomCode, joinToken };
  }

  return null;
}
