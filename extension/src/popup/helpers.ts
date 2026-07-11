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

export interface ParsedInvite {
  roomCode: string;
  /**
   * Invite token for private rooms. `null` means the room is open to anyone
   * who knows the 4-digit code, and the join request must omit `joinToken`.
   */
  joinToken: string | null;
}

export function parseInviteValue(value: string): ParsedInvite | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed.replace(/\s+/g, "");

  // 4-digit numeric room code — public join, no token required
  if (ROOM_CODE_PATTERN.test(normalized)) {
    return { roomCode: normalized, joinToken: null };
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

export function formatInviteDraft(invite: ParsedInvite | null): string {
  if (!invite) {
    return "";
  }
  // 4-digit room codes are public — never append the (private) join token
  // to the input field or copy buffer, because anyone holding the code is
  // allowed to join without it. For older rooms that shipped with a token,
  // hiding it matches what the server actually accepts.
  if (ROOM_CODE_PATTERN.test(invite.roomCode)) {
    return invite.roomCode;
  }
  return invite.joinToken
    ? `${invite.roomCode}:${invite.joinToken}`
    : invite.roomCode;
}
