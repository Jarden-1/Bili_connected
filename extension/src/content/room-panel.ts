/**
 * Room panel — a single-line inline panel injected below the Bilibili player.
 *
 * Two states:
 * - Not joined: [Create Room] [Join input] ........ [Nickname]
 * - Joined:     [Sync Page] [Room info+copy+leave] [Members] [Nickname]
 *
 * Nickname is editable inline (click to edit, Enter to save).
 * All room operations reuse existing background message channels
 * (content:create-room / content:join-room / content:leave-room /
 *  content:share-current-video / content:set-display-name).
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

const MOUNT_SELECTORS = [
  ".video-info-container",
  ".video-info-detail",
  ".bpx-player-container",
  ".bilibili-player",
];

const ROOM_CODE_PATTERN = /^[A-Z0-9]{6}$/;

function parseInviteCode(
  value: string,
): { roomCode: string; joinToken: string } | null {
  const trimmed = value.trim().replace(/\s+/g, "");
  if (!trimmed) {
    return null;
  }
  for (const sep of [":", "|", ","]) {
    const [roomCode, joinToken, ...rest] = trimmed.split(sep);
    if (!roomCode || !joinToken || rest.length > 0) {
      continue;
    }
    const normalized = roomCode.toUpperCase();
    if (!ROOM_CODE_PATTERN.test(normalized)) {
      continue;
    }
    if (joinToken.length < 16 || joinToken.length > 128) {
      continue;
    }
    return { roomCode: normalized, joinToken };
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
  * { box-sizing: border-box; }
  .bsp-panel {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 44px;
    padding: 0 12px;
    margin-bottom: 6px;
    background: #fff;
    border-radius: 8px;
    border: 1px solid #E3E5E7;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    font-size: 13px;
    color: #18191C;
    overflow: hidden;
  }
  .bsp-section {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
    min-width: 0;
  }
  .bsp-section[hidden] { display: none; }
  .bsp-btn {
    padding: 6px 14px;
    border: none;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    white-space: nowrap;
    transition: opacity 0.15s, background 0.15s;
    font-family: inherit;
  }
  .bsp-btn:disabled { opacity: 0.55; cursor: wait; }
  .bsp-btn-primary { background: ${BILI_BLUE}; color: #fff; }
  .bsp-btn-primary:hover:not(:disabled) { background: #00B5E5; }
  .bsp-btn-ghost {
    background: transparent; color: #9499A0;
    border: 1px solid #E3E5E7; padding: 3px 8px; font-size: 12px;
    border-radius: 4px; cursor: pointer; font-family: inherit;
  }
  .bsp-btn-ghost:hover:not(:disabled) { color: ${BILI_BLUE}; border-color: ${BILI_BLUE}; }
  .bsp-btn-danger {
    background: transparent; color: #F25D43;
    border: none; padding: 3px 8px; font-size: 12px;
    cursor: pointer; font-family: inherit;
  }
  .bsp-btn-danger:hover:not(:disabled) { color: #E0402E; }
  .bsp-join-input {
    flex: 1; min-width: 0;
    border: 1px dashed #C9CCD0; border-radius: 6px;
    padding: 5px 10px; font-size: 13px;
    background: transparent; color: #18191C; outline: none;
    font-family: inherit;
  }
  .bsp-join-input:focus { border-color: ${BILI_BLUE}; border-style: solid; }
  .bsp-join-input::placeholder { color: #C9CCD0; }
  .bsp-room-info {
    display: flex; align-items: center; gap: 4px;
    padding: 3px 8px; background: #F1F2F3; border-radius: 6px;
    min-width: 0;
  }
  .bsp-room-name {
    font-weight: 500; color: #18191C;
    max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .bsp-room-code {
    font-size: 11px; color: #9499A0; background: #fff;
    padding: 1px 5px; border-radius: 3px; font-family: monospace;
  }
  .bsp-members {
    display: flex; align-items: center; gap: 3px;
    margin-left: auto; flex-shrink: 0;
  }
  .bsp-member-avatar {
    width: 24px; height: 24px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-size: 10px; font-weight: 600; color: #fff;
    border: 2px solid #fff;
    box-shadow: 0 0 0 1px rgba(0,0,0,0.06);
  }
  .bsp-member-avatar.bsp-self { border-color: ${BILI_PINK}; }
  .bsp-member-count {
    font-size: 12px; color: ${BILI_BLUE}; font-weight: 500; margin-left: 2px;
  }
  .bsp-profile {
    display: flex; align-items: center; gap: 5px;
    cursor: pointer; padding: 3px 8px; border-radius: 6px;
    transition: background 0.15s;
    flex-shrink: 0;
  }
  .bsp-profile:hover { background: #F1F2F3; }
  .bsp-profile-avatar {
    width: 24px; height: 24px; border-radius: 50%;
    background: ${BILI_BLUE}; color: #fff;
    display: flex; align-items: center; justify-content: center;
    font-size: 10px; font-weight: 600;
    flex-shrink: 0;
  }
  .bsp-nick {
    font-size: 13px; color: #61666D;
    max-width: 100px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .bsp-name-editor {
    display: flex; align-items: center; gap: 4px;
    flex-shrink: 0;
  }
  .bsp-name-editor[hidden] { display: none; }
  .bsp-name-input {
    border: 1.5px solid ${BILI_BLUE}; border-radius: 6px; padding: 4px 8px;
    font-size: 13px; color: #18191C; outline: none;
    width: 100px; background: #fff; font-family: inherit;
  }
  .bsp-error {
    font-size: 12px; color: #F25D43; padding: 0 4px;
    flex-shrink: 0;
  }
  .bsp-error[hidden] { display: none; }
</style>
<div class="bsp-panel">
  <div class="bsp-section bsp-not-joined">
    <button class="bsp-btn bsp-btn-primary bsp-create-btn" type="button">创建房间</button>
    <input class="bsp-join-input" type="text" placeholder="输入邀请码加入" />
    <span class="bsp-error" hidden></span>
    <div class="bsp-profile bsp-profile-notjoined">
      <span class="bsp-profile-avatar"></span>
      <span class="bsp-nick"></span>
    </div>
  </div>
  <div class="bsp-section bsp-joined" hidden>
    <button class="bsp-btn bsp-btn-primary bsp-sync-btn" type="button">同步当前页</button>
    <div class="bsp-room-info">
      <span class="bsp-room-name"></span>
      <code class="bsp-room-code"></code>
      <button class="bsp-btn-ghost bsp-copy-btn" type="button">复制</button>
      <button class="bsp-btn-danger bsp-leave-btn" type="button">退出</button>
    </div>
    <span class="bsp-error" hidden></span>
    <div class="bsp-members"></div>
    <div class="bsp-profile bsp-profile-joined">
      <span class="bsp-profile-avatar"></span>
      <span class="bsp-nick"></span>
    </div>
  </div>
  <div class="bsp-name-editor" hidden>
    <input class="bsp-name-input" type="text" maxlength="${MAX_NAME_LENGTH}" />
    <button class="bsp-btn bsp-btn-primary bsp-name-ok" type="button" style="padding:4px 10px;">OK</button>
    <button class="bsp-btn-ghost bsp-name-cancel" type="button">X</button>
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
    if (
      mountPoint.classList.contains("video-info-container") ||
      mountPoint.classList.contains("video-info-detail")
    ) {
      mountPoint.insertBefore(host, mountPoint.firstChild);
    } else {
      mountPoint.insertAdjacentElement("afterend", host);
    }
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
      host.style.width = "100%";
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
    const syncBtn = shadow.querySelector<HTMLButtonElement>(".bsp-sync-btn");
    const copyBtn = shadow.querySelector<HTMLButtonElement>(".bsp-copy-btn");
    const leaveBtn = shadow.querySelector<HTMLButtonElement>(".bsp-leave-btn");
    const profileNotJoined = shadow.querySelector<HTMLDivElement>(
      ".bsp-profile-notjoined",
    );
    const profileJoined = shadow.querySelector<HTMLDivElement>(
      ".bsp-profile-joined",
    );
    const nameInput = shadow.querySelector<HTMLInputElement>(".bsp-name-input");
    const nameOk = shadow.querySelector<HTMLButtonElement>(".bsp-name-ok");
    const nameCancel =
      shadow.querySelector<HTMLButtonElement>(".bsp-name-cancel");

    createBtn?.addEventListener("click", () => void handleCreateRoom());

    joinInput?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void handleJoinRoom(joinInput.value);
      }
    });

    syncBtn?.addEventListener("click", () => void handleShareVideo());
    copyBtn?.addEventListener("click", () => void handleCopy());
    leaveBtn?.addEventListener("click", () => void handleLeaveRoom());

    profileNotJoined?.addEventListener("click", () => startEditName());
    profileJoined?.addEventListener("click", () => startEditName());

    nameOk?.addEventListener("click", () => void commitName());
    nameCancel?.addEventListener("click", () => cancelEditName());
    nameInput?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void commitName();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelEditName();
      }
    });
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
    const nameEditor = shadow.querySelector<HTMLDivElement>(".bsp-name-editor");

    if (nameEditing) {
      notJoined?.setAttribute("hidden", "");
      joined?.setAttribute("hidden", "");
      nameEditor?.removeAttribute("hidden");
      return;
    }
    nameEditor?.setAttribute("hidden", "");

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
  }

  function renderNotJoined(shadow: ShadowRoot): void {
    const createBtn =
      shadow.querySelector<HTMLButtonElement>(".bsp-create-btn");
    const joinInput = shadow.querySelector<HTMLInputElement>(".bsp-join-input");
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
    if (avatar) {
      const name = state.displayName ?? "Guest";
      avatar.textContent = getInitials(name);
      avatar.style.background = BILI_BLUE;
    }
    if (nick) {
      nick.textContent = state.displayName ?? "Click to set name";
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
    const roomCode = shadow.querySelector<HTMLElement>(".bsp-room-code");
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
      ? truncate(sharedVideo.title, 15)
      : `${state.displayName ?? "My"} room`;
    if (roomName) {
      roomName.textContent = roomNameText;
    }
    if (roomCode) {
      roomCode.textContent = state.roomCode ?? "";
    }

    if (membersEl && state.roomState) {
      const members = state.roomState.members;
      const children: HTMLElement[] = [];
      for (const m of members.slice(0, 8)) {
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
      nick.textContent = state.displayName ?? "Click to set name";
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
      const resp = await args.runtimeSendMessage<{
        ok: boolean;
        error?: string;
      }>({ type: "content:create-room" });
      if (resp && !resp.ok) {
        showError(resp.error ?? "Failed");
      }
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
    const token = state.joinToken ?? "";
    const invite = token ? `${code}:${token}` : code;
    try {
      await navigator.clipboard.writeText(invite);
      showError("Copied!");
    } catch {
      showError("Copy failed");
    }
  }

  function startEditName(): void {
    nameEditing = true;
    render();
    const shadow = getShadow();
    const input = shadow?.querySelector<HTMLInputElement>(".bsp-name-input");
    if (input) {
      input.value = state.displayName ?? "";
      input.focus();
      input.select();
    }
  }

  function cancelEditName(): void {
    nameEditing = false;
    render();
  }

  async function commitName(): Promise<void> {
    const shadow = getShadow();
    const input = shadow?.querySelector<HTMLInputElement>(".bsp-name-input");
    if (!input) {
      return;
    }
    const value = input.value.trim();
    if (!value) {
      showError("Name required");
      return;
    }
    if (value.length > MAX_NAME_LENGTH) {
      showError(`Max ${MAX_NAME_LENGTH} chars`);
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
      // Background may not be ready; apply-room-state will update later
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
