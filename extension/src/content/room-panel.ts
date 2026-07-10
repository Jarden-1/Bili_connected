/**
 * Room panel — a single-line inline panel injected next to Bilibili's
 * like/coin/favorite/share toolbar (right after the share icon, before the
 * three-dot menu).
 *
 * Two states:
 * - Not joined: [Create Room] [Invite input] [Join] ... [Nickname]
 * - Joined:     [Sync] [Room code + copy + leave] [Members] [Nickname]
 *
 * Nickname is editable inline (click to edit, Enter to save).
 */

import type { RoomState } from "@bili-syncplay/protocol";
import type { ContentToBackgroundMessage } from "../shared/messages";
import { setShadowRootTemplate } from "./shadow-template";

type RuntimeSendMessage = <T>(
  message: ContentToBackgroundMessage,
) => Promise<T | null>;

interface PanelState {
  connected: boolean;
  roomCode: string | null;
  joinToken: string | null;
  displayName: string | null;
  memberId: string | null;
  roomState: RoomState | null;
  pending: "none" | "create" | "join" | "leave" | "share" | "name";
  error: string | null;
}

export interface RoomPanelController {
  start(): void;
  applyRoomState(roomState: RoomState): void;
  handleSyncStatus(payload: {
    roomCode: string | null;
    connected: boolean;
    memberId: string | null;
  }): void;
  resetMountTarget(): void;
  destroy(): void;
}

const BILI_BLUE = "#00A1D6";
const BILI_PINK = "#FB7299";
const MOUNT_CHECK_INTERVAL_MS = 600;
const ERROR_DISPLAY_MS = 3000;
const MAX_NAME_LENGTH = 20;

const MEMBER_COLORS = [
  "#00A1D6",
  "#FB7299",
  "#02B340",
  "#FF9500",
  "#9B59B6",
  "#E74C3C",
  "#1ABC9C",
  "#F39C12",
  "#3498DB",
  "#E67E22",
  "#2ECC71",
  "#E91E63",
];

// Inject the panel inside the toolbar container, after .toolbar-left and
// before .toolbar-right (which is the three-dot menu). Fall back to other
// anchors if the toolbar structure isn't available.
const MOUNT_SELECTORS = [
  ".video-toolbar-container .toolbar-left",
  ".video-toolbar-container",
  ".video-info-container",
  ".bpx-player-container",
  ".bilibili-player",
];

const ROOM_CODE_PATTERN = /^\d{4}$/;

function parseInviteCode(
  value: string,
): { roomCode: string; joinToken: string } | null {
  const trimmed = value.trim().replace(/\s+/g, "");
  if (!trimmed) {
    return null;
  }
  // 4-digit numeric room code (no joinToken needed)
  if (ROOM_CODE_PATTERN.test(trimmed)) {
    return { roomCode: trimmed, joinToken: "" };
  }
  // Full format: roomCode:joinToken (backward compat)
  for (const sep of [":", "|", ","]) {
    const [roomCode, joinToken, ...rest] = trimmed.split(sep);
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

function getMemberColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
  }
  return MEMBER_COLORS[Math.abs(hash) % MEMBER_COLORS.length];
}

function getInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    return "?";
  }
  if (/[\u4e00-\u9fa5]/.test(trimmed)) {
    return trimmed.charAt(0);
  }
  return trimmed.substring(0, 2).toUpperCase();
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.substring(0, max) + "..." : text;
}

const PANEL_TEMPLATE = `
<style>
  :host { all: initial; display: block; }
  * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif; }
  .bsp-panel {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 32px;
    padding: 0 8px;
    background: #F6F7F8;
    border-radius: 6px;
    color: #18191C;
    font-size: 12px;
    overflow: hidden;
  }
  .bsp-section {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    min-width: 0;
  }
  .bsp-section[hidden] { display: none; }

  .bsp-btn {
    border: none;
    border-radius: 4px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    white-space: nowrap;
    transition: opacity 0.15s, background 0.15s;
    font-family: inherit;
    line-height: 1;
  }
  .bsp-btn:disabled { opacity: 0.5; cursor: wait; }
  .bsp-btn-primary {
    background: ${BILI_BLUE};
    color: #fff;
    padding: 6px 10px;
  }
  .bsp-btn-primary:hover:not(:disabled) { background: #00B5E5; }
  .bsp-btn-ghost {
    background: transparent;
    color: #61666D;
    padding: 5px 8px;
  }
  .bsp-btn-ghost:hover:not(:disabled) { color: ${BILI_BLUE}; }
  .bsp-btn-danger {
    background: transparent;
    color: #919499;
    padding: 5px 6px;
    font-size: 11px;
  }
  .bsp-btn-danger:hover:not(:disabled) { color: #F25D43; }

  .bsp-join-input {
    flex: 1;
    min-width: 0;
    border: 1px solid #E3E5E7;
    border-radius: 4px;
    padding: 5px 8px;
    font-size: 12px;
    background: #fff;
    color: #18191C;
    outline: none;
    font-family: inherit;
  }
  .bsp-join-input:focus { border-color: ${BILI_BLUE}; }
  .bsp-join-input::placeholder { color: #C9CCD0; }

  .bsp-room-info {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 6px;
    background: #fff;
    border-radius: 4px;
    min-width: 0;
  }
  .bsp-room-name {
    font-weight: 500;
    color: #18191C;
    max-width: 100px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .bsp-room-code {
    font-size: 11px;
    color: #9499A0;
    font-family: monospace;
  }

  .bsp-members {
    display: flex;
    align-items: center;
    gap: 2px;
    margin-left: auto;
    flex-shrink: 0;
  }
  .bsp-member-avatar {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 9px;
    font-weight: 600;
    color: #fff;
    border: 1.5px solid #F6F7F8;
  }
  .bsp-member-avatar.bsp-self { border-color: ${BILI_PINK}; }
  .bsp-member-count {
    font-size: 11px;
    color: ${BILI_BLUE};
    font-weight: 500;
    margin-left: 2px;
  }

  .bsp-profile {
    display: flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
    padding: 3px 6px;
    border-radius: 4px;
    transition: background 0.15s;
    flex-shrink: 0;
  }
  .bsp-profile:hover { background: rgba(0,0,0,0.04); }
  .bsp-profile-avatar {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: ${BILI_BLUE};
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 9px;
    font-weight: 600;
    flex-shrink: 0;
  }
  .bsp-nick {
    font-size: 12px;
    color: #61666D;
    max-width: 70px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .bsp-name-editor {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }
  .bsp-name-editor[hidden] { display: none; }
  .bsp-name-input {
    border: 1.5px solid ${BILI_BLUE};
    border-radius: 4px;
    padding: 4px 6px;
    font-size: 12px;
    color: #18191C;
    outline: none;
    width: 80px;
    background: #fff;
    font-family: inherit;
  }

  .bsp-error {
    font-size: 11px;
    color: #F25D43;
    padding: 0 4px;
    flex-shrink: 0;
  }
  .bsp-error[hidden] { display: none; }
</style>
<div class="bsp-panel">
  <div class="bsp-section bsp-not-joined">
    <button class="bsp-btn bsp-btn-primary bsp-create-btn" type="button">创建房间</button>
    <input class="bsp-join-input" type="text" placeholder="输入邀请码" />
    <button class="bsp-btn bsp-btn-primary bsp-join-btn" type="button" style="padding:5px 10px;">加入</button>
    <span class="bsp-error" hidden></span>
    <div class="bsp-profile bsp-profile-notjoined">
      <span class="bsp-profile-avatar"></span>
      <span class="bsp-nick"></span>
    </div>
  </div>
  <div class="bsp-section bsp-joined" hidden>
    <button class="bsp-btn bsp-btn-primary bsp-sync-btn" type="button">同步</button>
    <div class="bsp-room-info">
      <span class="bsp-room-name"></span>
      <span class="bsp-room-code"></span>
      <button class="bsp-btn-ghost bsp-copy-btn" type="button" style="padding:3px 5px;">复制</button>
      <button class="bsp-btn-danger bsp-leave-btn" type="button">退出</button>
    </div>
    <span class="bsp-error" hidden></span>
    <div class="bsp-members"></div>
    <div class="bsp-profile bsp-profile-joined">
      <span class="bsp-profile-avatar"></span>
      <span class="bsp-nick"></span>
    </div>
  </div>
</div>
`;

export function createRoomPanelController(args: {
  runtimeSendMessage: RuntimeSendMessage;
}): RoomPanelController {
  let host: HTMLDivElement | null = null;
  let started = false;
  let mountCheckTimer = 0;
  let errorTimer = 0;
  let nameEditing = false;

  const state: PanelState = {
    connected: false,
    roomCode: null,
    joinToken: null,
    displayName: null,
    memberId: null,
    roomState: null,
    pending: "none",
    error: null,
  };

  function getShadow(): ShadowRoot | null {
    return host?.shadowRoot ?? null;
  }

  function findMountPoint(): HTMLElement | null {
    for (const selector of MOUNT_SELECTORS) {
      const el = document.querySelector(selector);
      if (el instanceof HTMLElement) {
        return el;
      }
    }
    return null;
  }

  function injectInto(mountPoint: HTMLElement): void {
    if (!host) {
      return;
    }
    if (mountPoint.classList.contains("toolbar-left")) {
      // Insert after toolbar-left, before toolbar-right (the three-dot menu).
      const parent = mountPoint.parentElement;
      if (parent) {
        const toolbarRight = parent.querySelector(".toolbar-right");
        if (toolbarRight) {
          parent.insertBefore(host, toolbarRight);
        } else {
          parent.appendChild(host);
        }
      }
      return;
    }
    if (
      mountPoint.classList.contains("video-info-container") ||
      mountPoint.classList.contains("video-info-detail")
    ) {
      mountPoint.insertBefore(host, mountPoint.firstChild);
      return;
    }
    mountPoint.insertAdjacentElement("afterend", host);
  }

  function ensureMounted(): void {
    if (!started) {
      return;
    }
    const mountPoint = findMountPoint();
    if (!mountPoint) {
      scheduleMountCheck();
      return;
    }
    if (host?.isConnected) {
      if (
        host.parentElement === mountPoint ||
        host.parentElement === mountPoint.parentElement
      ) {
        render();
        return;
      }
    }
    if (!host) {
      host = document.createElement("div");
      host.className = "bsp-room-panel-host";
      host.style.width = "fit-content";
      host.style.maxWidth = "100%";
      host.style.marginLeft = "8px";
      host.style.display = "inline-block";
      host.style.verticalAlign = "middle";
      const shadow = host.attachShadow({ mode: "open" });
      setShadowRootTemplate(shadow, PANEL_TEMPLATE);
      bindEvents(shadow);
    }
    injectInto(mountPoint);
    render();
  }

  function scheduleMountCheck(): void {
    if (mountCheckTimer) {
      return;
    }
    mountCheckTimer = window.setInterval(() => {
      if (!started) {
        window.clearInterval(mountCheckTimer);
        mountCheckTimer = 0;
        return;
      }
      ensureMounted();
    }, MOUNT_CHECK_INTERVAL_MS);
  }

  function bindEvents(shadow: ShadowRoot): void {
    const createBtn =
      shadow.querySelector<HTMLButtonElement>(".bsp-create-btn");
    const joinInput = shadow.querySelector<HTMLInputElement>(".bsp-join-input");
    const joinBtn = shadow.querySelector<HTMLButtonElement>(".bsp-join-btn");
    const syncBtn = shadow.querySelector<HTMLButtonElement>(".bsp-sync-btn");
    const copyBtn = shadow.querySelector<HTMLButtonElement>(".bsp-copy-btn");
    const leaveBtn = shadow.querySelector<HTMLButtonElement>(".bsp-leave-btn");
    const profileNotJoined = shadow.querySelector<HTMLDivElement>(
      ".bsp-profile-notjoined",
    );
    const profileJoined = shadow.querySelector<HTMLDivElement>(
      ".bsp-profile-joined",
    );

    createBtn?.addEventListener("click", () => void handleCreateRoom());

    joinInput?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void handleJoinRoom(joinInput.value);
      }
    });
    joinBtn?.addEventListener("click", () => {
      if (joinInput) {
        void handleJoinRoom(joinInput.value);
      }
    });

    syncBtn?.addEventListener("click", () => void handleShareVideo());
    copyBtn?.addEventListener("click", () => void handleCopy());
    leaveBtn?.addEventListener("click", () => void handleLeaveRoom());

    profileNotJoined?.addEventListener("click", () => startEditName());
    profileJoined?.addEventListener("click", () => startEditName());
  }

  function showError(message: string): void {
    state.error = message;
    render();
    if (errorTimer) {
      window.clearTimeout(errorTimer);
    }
    errorTimer = window.setTimeout(() => {
      state.error = null;
      render();
    }, ERROR_DISPLAY_MS);
  }

  function render(): void {
    const shadow = getShadow();
    if (!shadow) {
      return;
    }
    const notJoined = shadow.querySelector<HTMLDivElement>(".bsp-not-joined");
    const joined = shadow.querySelector<HTMLDivElement>(".bsp-joined");

    const isJoined = Boolean(state.roomCode && state.roomState);
    if (isJoined) {
      notJoined?.setAttribute("hidden", "");
      joined?.removeAttribute("hidden");
      renderJoined(shadow);
    } else {
      joined?.setAttribute("hidden", "");
      notJoined?.removeAttribute("hidden");
      renderNotJoined(shadow);
    }

    // Inline nickname editing — don't hide sections, just swap the nick
    // text for an input inside the visible profile area.
    updateInlineNameEditor(shadow);
  }

  function updateInlineNameEditor(shadow: ShadowRoot): void {
    const profiles = [
      shadow.querySelector<HTMLDivElement>(".bsp-profile-notjoined"),
      shadow.querySelector<HTMLDivElement>(".bsp-profile-joined"),
    ];
    for (const profile of profiles) {
      if (!profile) {
        continue;
      }
      const nick = profile.querySelector<HTMLSpanElement>(".bsp-nick");
      const input = profile.querySelector<HTMLInputElement>(
        ".bsp-name-input-inline",
      );

      const isProfileVisible = profile.isConnected && !profile.closest("[hidden]");

      if (nameEditing && isProfileVisible) {
        if (nick) {
          nick.style.display = "none";
        }
        if (!input) {
          const newInput = document.createElement("input");
          newInput.className = "bsp-name-input-inline";
          newInput.type = "text";
          newInput.maxLength = MAX_NAME_LENGTH;
          Object.assign(newInput.style, {
            border: `1.5px solid ${BILI_BLUE}`,
            borderRadius: "4px",
            padding: "2px 4px",
            fontSize: "12px",
            width: "70px",
            background: "#fff",
            outline: "none",
            fontFamily: "inherit",
          } as CSSStyleDeclaration);
          profile.appendChild(newInput);
          newInput.value = state.displayName ?? "";
          newInput.focus();
          newInput.select();
          newInput.addEventListener("keydown", (e: KeyboardEvent) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void commitNameInline(newInput);
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancelEditName();
            }
          });
          newInput.addEventListener("blur", () => {
            if (nameEditing) {
              void commitNameInline(newInput);
            }
          });
        }
      } else {
        if (nick) {
          nick.style.display = "";
        }
        input?.remove();
      }
    }
  }

  async function commitNameInline(input: HTMLInputElement): Promise<void> {
    const value = input.value.trim();
    if (!value) {
      cancelEditName();
      return;
    }
    if (value.length > MAX_NAME_LENGTH) {
      return;
    }
    nameEditing = false;
    state.pending = "name";
    render();
    try {
      const resp = await args.runtimeSendMessage<{
        ok: boolean;
        displayName?: string;
      }>({ type: "content:set-display-name", displayName: value });
      if (resp?.ok && resp.displayName) {
        state.displayName = resp.displayName;
      }
    } catch {
      // ignore
    } finally {
      state.pending = "none";
      render();
    }
  }

  function renderNotJoined(shadow: ShadowRoot): void {
    const createBtn =
      shadow.querySelector<HTMLButtonElement>(".bsp-create-btn");
    const joinInput = shadow.querySelector<HTMLInputElement>(".bsp-join-input");
    const joinBtn = shadow.querySelector<HTMLButtonElement>(".bsp-join-btn");
    const errorEl = shadow.querySelector<HTMLSpanElement>(
      ".bsp-not-joined .bsp-error",
    );
    const avatar = shadow.querySelector<HTMLSpanElement>(
      ".bsp-profile-notjoined .bsp-profile-avatar",
    );
    const nick = shadow.querySelector<HTMLSpanElement>(
      ".bsp-profile-notjoined .bsp-nick",
    );

    if (createBtn) {
      createBtn.disabled = state.pending === "create";
    }
    if (joinInput) {
      joinInput.disabled = state.pending === "join";
    }
    if (joinBtn) {
      joinBtn.disabled = state.pending === "join";
    }
    if (avatar) {
      const name = state.displayName ?? "Guest";
      avatar.textContent = getInitials(name);
      avatar.style.background = BILI_BLUE;
    }
    if (nick) {
      nick.textContent = state.displayName ?? "set name";
    }
    if (errorEl) {
      if (state.error) {
        errorEl.textContent = state.error;
        errorEl.removeAttribute("hidden");
      } else {
        errorEl.setAttribute("hidden", "");
      }
    }
  }

  function renderJoined(shadow: ShadowRoot): void {
    const syncBtn = shadow.querySelector<HTMLButtonElement>(".bsp-sync-btn");
    const roomName = shadow.querySelector<HTMLSpanElement>(".bsp-room-name");
    const roomCode = shadow.querySelector<HTMLSpanElement>(".bsp-room-code");
    const copyBtn = shadow.querySelector<HTMLButtonElement>(".bsp-copy-btn");
    const leaveBtn = shadow.querySelector<HTMLButtonElement>(".bsp-leave-btn");
    const membersEl = shadow.querySelector<HTMLDivElement>(".bsp-members");
    const errorEl = shadow.querySelector<HTMLSpanElement>(
      ".bsp-joined .bsp-error",
    );
    const avatar = shadow.querySelector<HTMLSpanElement>(
      ".bsp-profile-joined .bsp-profile-avatar",
    );
    const nick = shadow.querySelector<HTMLSpanElement>(
      ".bsp-profile-joined .bsp-nick",
    );

    if (syncBtn) {
      syncBtn.disabled = state.pending === "share";
    }
    if (leaveBtn) {
      leaveBtn.disabled = state.pending === "leave";
    }

    const sharedVideo = state.roomState?.sharedVideo;
    const roomNameText = sharedVideo?.title
      ? truncate(sharedVideo.title, 10)
      : "SyncPlay";
    if (roomName) {
      roomName.textContent = roomNameText;
    }
    if (roomCode) {
      roomCode.textContent = state.roomCode ?? "";
    }

    if (membersEl && state.roomState) {
      const members = state.roomState.members;
      const children: HTMLElement[] = [];
      for (const m of members.slice(0, 6)) {
        const el = document.createElement("div");
        el.className = "bsp-member-avatar";
        if (m.id === state.memberId) {
          el.classList.add("bsp-self");
        }
        el.textContent = getInitials(m.name);
        el.style.background = getMemberColor(m.id);
        el.title = m.name + (m.id === state.memberId ? " (me)" : "");
        children.push(el);
      }
      if (members.length > 0) {
        const count = document.createElement("span");
        count.className = "bsp-member-count";
        count.textContent = `${members.length}`;
        children.push(count);
      }
      membersEl.replaceChildren(...children);
    }

    if (avatar) {
      const name = state.displayName ?? "Me";
      avatar.textContent = getInitials(name);
      avatar.style.background = state.memberId
        ? getMemberColor(state.memberId)
        : BILI_BLUE;
    }
    if (nick) {
      nick.textContent = state.displayName ?? "me";
    }

    if (errorEl) {
      if (state.error) {
        errorEl.textContent = state.error;
        errorEl.removeAttribute("hidden");
      } else {
        errorEl.setAttribute("hidden", "");
      }
    }
  }

  async function handleCreateRoom(): Promise<void> {
    state.pending = "create";
    render();
    try {
      await args.runtimeSendMessage({ type: "content:create-room" });
      // Force a re-fetch so state.joinToken reflects the freshly created room
      void fetchInitialState();
    } catch (e) {
      showError(e instanceof Error ? e.message : "Failed");
    } finally {
      state.pending = "none";
      render();
    }
  }

  async function handleJoinRoom(value: string): Promise<void> {
    const parsed = parseInviteCode(value);
    if (!parsed) {
      showError("Format: ROOMCODE:TOKEN");
      return;
    }
    state.pending = "join";
    render();
    try {
      const resp = await args.runtimeSendMessage<{
        ok: boolean;
        error?: string;
      }>({
        type: "content:join-room",
        roomCode: parsed.roomCode,
        joinToken: parsed.joinToken,
      });
      if (resp && !resp.ok) {
        showError(resp.error ?? "Join failed");
      }
    } catch (e) {
      showError(e instanceof Error ? e.message : "Join failed");
    } finally {
      state.pending = "none";
      const shadow = getShadow();
      const input = shadow?.querySelector<HTMLInputElement>(".bsp-join-input");
      if (input) {
        input.value = "";
      }
      render();
    }
  }

  async function handleLeaveRoom(): Promise<void> {
    state.pending = "leave";
    render();
    try {
      await args.runtimeSendMessage({ type: "content:leave-room" });
    } catch (e) {
      showError(e instanceof Error ? e.message : "Leave failed");
    } finally {
      state.pending = "none";
      render();
    }
  }

  async function handleShareVideo(): Promise<void> {
    state.pending = "share";
    render();
    try {
      const resp = await args.runtimeSendMessage<{
        ok: boolean;
        error?: string;
      }>({ type: "content:share-current-video" });
      if (resp && !resp.ok) {
        showError(resp.error ?? "Share failed");
      }
    } catch (e) {
      showError(e instanceof Error ? e.message : "Share failed");
    } finally {
      state.pending = "none";
      render();
    }
  }

  async function handleCopy(): Promise<void> {
    const code = state.roomCode ?? "";
    try {
      await navigator.clipboard.writeText(code);
      showError("Copied!");
    } catch {
      showError("Copy failed");
    }
  }

  function startEditName(): void {
    nameEditing = true;
    render();
  }

  function cancelEditName(): void {
    nameEditing = false;
    render();
  }

  async function fetchInitialState(): Promise<void> {
    try {
      const resp = await args.runtimeSendMessage<{
        ok: boolean;
        roomState: RoomState | null;
        roomCode: string | null;
        memberId: string | null;
        displayName: string | null;
        joinToken: string | null;
      }>({ type: "content:get-room-state" });
      if (resp) {
        state.roomCode = resp.roomCode;
        state.memberId = resp.memberId;
        state.displayName = resp.displayName;
        state.joinToken = resp.joinToken;
        if (resp.ok && resp.roomState) {
          state.roomState = resp.roomState;
        }
        render();
      }
    } catch {
      // ignore
    }
  }

  return {
    start() {
      if (started) {
        ensureMounted();
        return;
      }
      started = true;
      ensureMounted();
      void fetchInitialState();
    },
    applyRoomState(roomState) {
      state.roomState = roomState;
      state.roomCode = roomState.roomCode;
      render();
    },
    handleSyncStatus(payload) {
      state.connected = payload.connected;
      state.roomCode = payload.roomCode;
      state.memberId = payload.memberId;
      render();
    },
    resetMountTarget: ensureMounted,
    destroy() {
      started = false;
      if (mountCheckTimer) {
        window.clearInterval(mountCheckTimer);
        mountCheckTimer = 0;
      }
      if (errorTimer) {
        window.clearTimeout(errorTimer);
        errorTimer = 0;
      }
      host?.remove();
      host = null;
    },
  };
}
