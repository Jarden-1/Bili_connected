/**
 * Danmaku chat — lets the user send text to everyone in the room from the
 * Bilibili video page. Two rendering modes are chosen automatically based on
 * whether Bilibili's native danmaku input is currently usable:
 *
 *   1. Parasite mode (danmaku on): a pink "发送到房间" button is butted flush
 *      against Bilibili's own send button, reading as one seamless pill. The
 *      native input box is left untouched so regular danmaku still works.
 *   2. Overlay mode (danmaku off): Bilibili hides/collapses its own input, so
 *      we float a visually-matched input box over the native sending-area
 *      container (falling back to the player's bottom-right corner if that
 *      container can't be located). This mimics "typing in the original box".
 *
 * Both modes only appear while the user is actually in a room — the controller
 * is told about room membership via setRoomActive(). Outside a room, no
 * "发送到房间" affordance is shown at all.
 *
 * Incoming room:chat messages render as colored scrolling danmaku on top of
 * the video player (per-user color + border + nickname prefix).
 */

import type { ContentToBackgroundMessage } from "../shared/messages";

type RuntimeSendMessage = <T>(
  message: ContentToBackgroundMessage,
) => Promise<T | null>;

export interface DanmakuChatController {
  start(): void;
  /**
   * Tells the controller whether the user is currently in a room. The
   * "发送到房间" button / overlay input is only shown while active === true;
   * turning it off tears down whichever input mode is currently mounted.
   */
  setRoomActive(active: boolean): void;
  handleRoomChat(payload: {
    memberId: string;
    displayName: string;
    text: string;
    timestamp: number;
  }): void;
  destroy(): void;
}

const BILI_PINK = "#FB7299";
const MOUNT_CHECK_MS = 600;
const DANMAKU_SPEED_PX_PER_SEC = 120;
const DANMAKU_FONT_SIZE = 22;
const MAX_DANMAKU_ITEMS = 20;

const MEMBER_COLORS = [
  "#00A1D6",
  "#FB7299",
  "#02B340",
  "#FF9500",
  "#9B59B6",
  "#E74C3C",
  "#1ABC9C",
  "#F39C12",
  "#3499DB",
  "#E67E22",
  "#2ECC71",
  "#E91E63",
];

const INPUT_SELECTORS = [
  "textarea.bpx-player-dm-input",
  "input.bilibili-player-video-danmaku-input",
  ".bpx-player-dm-input",
];

const SEND_BTN_SELECTORS = [
  ".bpx-player-dm-btn-send",
  ".bilibili-player-video-danmaku-btn-send",
  ".bpx-player-dm-btn",
];

const VIDEO_AREA_SELECTORS = [
  ".bpx-player-video-area",
  ".bilibili-player-video-wrap",
  ".bpx-player-container",
  ".bilibili-player",
];

// Native danmaku "sending area" container — the box that holds the input +
// send button. When danmaku is turned off Bilibili hides/collapses the input
// *inside* this container, but the container itself usually keeps its slot in
// the control bar. We overlay our own input on top of this container so it
// reads as "the original input box". Ordered most-specific first.
const SENDING_AREA_SELECTORS = [
  ".bpx-player-sending-area",
  ".bpx-player-dm-wrap",
  ".bpx-player-video-inputbar",
];

// Detects whether Bilibili's native danmaku input is truly usable right now.
// When the user turns danmaku off, Bilibili either removes the input, disables
// it, or collapses it to zero size — any of which means we can no longer
// piggy-back on it and must fall back to our own standalone input.
function isElementUsable(el: HTMLElement | null): el is HTMLElement {
  if (!el || !el.isConnected) {
    return false;
  }
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (el.disabled || el.readOnly) {
      return false;
    }
  }
  const cs = window.getComputedStyle(el);
  if (
    cs.display === "none" ||
    cs.visibility === "hidden" ||
    Number.parseFloat(cs.opacity || "1") === 0
  ) {
    return false;
  }
  const rect = el.getBoundingClientRect();
  return rect.width > 1 && rect.height > 1;
}

function getMemberColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
  }
  return MEMBER_COLORS[Math.abs(hash) % MEMBER_COLORS.length];
}

function querySelector(selectors: string[]): HTMLElement | null {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el instanceof HTMLElement) {
      return el;
    }
  }
  return null;
}

const OVERLAY_TEMPLATE = `
<style>
  :host { all: initial; }
  .bsp-danmaku-overlay {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 48px;
    overflow: hidden;
    pointer-events: none;
    z-index: 70;
  }
  .bsp-danmaku-item {
    position: absolute;
    white-space: nowrap;
    font-size: ${DANMAKU_FONT_SIZE}px;
    font-weight: 600;
    color: #ffffff;
    text-shadow: 0 1px 3px rgba(0,0,0,0.85);
    padding: 2px 8px;
    border-radius: 3px;
    border: 1px solid;
    will-change: transform;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  .bsp-danmaku-nick {
    font-size: 13px;
    font-weight: 500;
    padding: 0 5px;
    border-radius: 2px;
    background: rgba(0,0,0,0.3);
  }
</style>
<div class="bsp-danmaku-overlay"></div>
`;

export function createDanmakuChatController(args: {
  runtimeSendMessage: RuntimeSendMessage;
}): DanmakuChatController {
  let overlayHost: HTMLDivElement | null = null;
  let overlay: HTMLDivElement | null = null;
  let currentVideoArea: HTMLElement | null = null;
  let overlayResizeObserver: ResizeObserver | null = null;
  let roomButton: HTMLButtonElement | null = null;
  let inputEl: HTMLTextAreaElement | HTMLInputElement | null = null;
  let sendBtnEl: HTMLElement | null = null;
  // Remembers the send button's original right-side rounding so we can restore
  // it on unmount. While our "发送到房间" button is attached we square off the
  // send button's right corners so the two controls read as one seamless pill.
  let sendBtnOriginalBorderRadius: string | null = null;
  // Overlay room-chat input, mounted only when Bilibili's native danmaku input
  // is unavailable (danmaku turned off). It is positioned over the native
  // sending-area container (or the player's bottom-right corner as a fallback)
  // so it reads like typing in the original box. Guarantees the user can always
  // send to the room regardless of the danmaku on/off state.
  let overlayInputHost: HTMLDivElement | null = null;
  let overlayInput: HTMLInputElement | null = null;
  // Container we anchored the overlay input to, plus the observer/handlers that
  // keep the overlay glued to it as the layout changes. Cleared on teardown.
  let overlayAnchor: HTMLElement | null = null;
  let overlayInputResizeObserver: ResizeObserver | null = null;
  // Whether the user is currently in a room. No "发送到房间" affordance is
  // shown while this is false.
  let roomActive = false;
  let started = false;
  let mountTimer = 0;
  let danmakuCount = 0;
  const danmakuItems: HTMLDivElement[] = [];

  function ensureOverlayMounted(): void {
    if (!started) {
      return;
    }
    const videoArea = querySelector(VIDEO_AREA_SELECTORS);
    if (!videoArea) {
      scheduleMountCheck();
      return;
    }
    if (overlayHost?.isConnected) {
      return;
    }
    if (!overlayHost) {
      overlayHost = document.createElement("div");
      overlayHost.className = "bsp-danmaku-overlay-host";
      // Use position:fixed and absolute viewport coordinates so we never
      // touch Bilibili's own inline styles (mutating them broke the
      // page's image rendering by disturbing React's style bindings).
      Object.assign(overlayHost.style, {
        position: "fixed",
        top: "0",
        left: "0",
        right: "0",
        bottom: "0",
        pointerEvents: "none",
        zIndex: "70",
      });
      const shadow = overlayHost.attachShadow({ mode: "open" });
      const template = document.createElement("template");
      template.innerHTML = OVERLAY_TEMPLATE.trim();
      shadow.appendChild(template.content.cloneNode(true));
      overlay = shadow.querySelector(".bsp-danmaku-overlay");
    }
    document.body.appendChild(overlayHost);
    currentVideoArea = videoArea;
    updateOverlayPosition();
    if (overlayResizeObserver) {
      overlayResizeObserver.disconnect();
    }
    overlayResizeObserver = new ResizeObserver(() => updateOverlayPosition());
    overlayResizeObserver.observe(videoArea);
    window.addEventListener("scroll", updateOverlayPosition, { passive: true });
    window.addEventListener("resize", updateOverlayPosition, { passive: true });
  }

  function updateOverlayPosition(): void {
    if (!overlayHost || !currentVideoArea) {
      return;
    }
    const rect = currentVideoArea.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }
    const heightExcludingControls = Math.max(0, rect.height - 48);
    overlayHost.style.left = `${rect.left}px`;
    overlayHost.style.top = `${rect.top}px`;
    overlayHost.style.width = `${rect.width}px`;
    overlayHost.style.height = `${heightExcludingControls}px`;
    if (overlay) {
      overlay.style.width = `${rect.width}px`;
      overlay.style.height = `${heightExcludingControls}px`;
    }
  }

  function ensureInputButtonMounted(): void {
    if (!started) {
      return;
    }

    // No room → no "发送到房间" affordance at all. Tear down whichever mode is
    // mounted and stop. (The overlay danmaku display is independent and stays.)
    if (!roomActive) {
      teardownParasiteButton();
      teardownOverlayInput();
      return;
    }

    const input = querySelector(INPUT_SELECTORS);
    const sendBtn = querySelector(SEND_BTN_SELECTORS);

    // Decide which mode to use. When Bilibili's native danmaku input is usable
    // (danmaku on), we piggy-back on it (parasite mode). When it is missing or
    // disabled (danmaku off), we float our own overlay input over the native
    // sending-area so the user can still send to the room. We re-evaluate on
    // every mount check so toggling danmaku on/off flips modes automatically.
    const nativeUsable = isElementUsable(input) && isElementUsable(sendBtn);

    if (!nativeUsable) {
      // Native input unavailable — tear down parasite UI (restoring the send
      // button corners) and switch to our overlay input.
      teardownParasiteButton();
      ensureOverlayInputMounted();
      scheduleMountCheck();
      return;
    }

    // Native input is usable — make sure any overlay fallback is removed so we
    // never show two inputs at once, then (re)attach the parasite button.
    teardownOverlayInput();

    if (inputEl !== input) {
      inputEl = (input as HTMLTextAreaElement | HTMLInputElement) ?? null;
    }
    if (sendBtnEl !== sendBtn) {
      sendBtnEl = sendBtn;
    }

    if (roomButton?.isConnected) {
      return;
    }

    const anchor = sendBtn?.parentElement ?? input?.parentElement;
    if (!anchor) {
      scheduleMountCheck();
      return;
    }

    // Square off the send button's right corners so our pink button can butt
    // directly against it and the pair reads as one continuous pill (blue-left
    // rounded, pink-right rounded, no seam in the middle). We stash the original
    // radius to restore it when we detach.
    if (sendBtn instanceof HTMLElement) {
      if (sendBtnOriginalBorderRadius === null) {
        sendBtnOriginalBorderRadius = sendBtn.style.borderRadius || "";
      }
      sendBtn.style.borderTopRightRadius = "0";
      sendBtn.style.borderBottomRightRadius = "0";
    }

    roomButton = document.createElement("button");
    roomButton.type = "button";
    roomButton.textContent = "发送到房间";
    roomButton.title = "把当前输入框的内容发送给同房间的人";
    // Butt flush against the (now square-right) send button with zero gap so the
    // two surfaces form a single seamless pill: our left edge is squared to meet
    // the send button, our right edge carries the pill rounding. The vertical
    // padding mirrors the send button so baselines line up; the wider right
    // padding lets the longer "发送到房间" label breathe without inflating height.
    Object.assign(roomButton.style, {
      background: BILI_PINK,
      color: "#fff",
      border: "none",
      borderRadius: "0 4px 4px 0",
      padding: sendBtn ? buildAdjacentButtonPadding(sendBtn) : "0 16px 0 12px",
      height: sendBtn ? getSendButtonHeight(sendBtn) : "auto",
      minWidth: "auto",
      marginLeft: "0",
      position: "relative",
      zIndex: "1",
      fontSize: sendBtn ? getSendButtonFontSize(sendBtn) : "12px",
      fontWeight: "500",
      cursor: "pointer",
      whiteSpace: "nowrap",
      transition: "background 0.15s, opacity 0.15s",
      fontFamily: "inherit",
      lineHeight: sendBtn ? getSendButtonLineHeight(sendBtn) : "normal",
      verticalAlign: sendBtn
        ? getComputedStyle(sendBtn).verticalAlign || "middle"
        : "middle",
    } as CSSStyleDeclaration);

    roomButton.addEventListener("mouseenter", () => {
      if (!roomButton) {
        return;
      }
      roomButton.style.background = "#E85A8B";
    });
    roomButton.addEventListener("mouseleave", () => {
      if (!roomButton) {
        return;
      }
      roomButton.style.background = BILI_PINK;
    });
    roomButton.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void handleSendToRoom();
    });

    if (sendBtn && sendBtn.parentElement === anchor) {
      anchor.insertBefore(roomButton, sendBtn.nextSibling);
    } else {
      anchor.appendChild(roomButton);
    }
  }

  // Removes the parasite "发送到房间" button and restores the native send
  // button's original corners. Safe to call repeatedly (no-op if not mounted).
  function teardownParasiteButton(): void {
    roomButton?.remove();
    roomButton = null;
    if (
      sendBtnEl instanceof HTMLElement &&
      sendBtnOriginalBorderRadius !== null
    ) {
      sendBtnEl.style.borderRadius = sendBtnOriginalBorderRadius;
    }
    sendBtnOriginalBorderRadius = null;
    sendBtnEl = null;
    inputEl = null;
  }

  // Mounts our overlay room-chat input, used when the native danmaku input is
  // off/unavailable. Strategy: locate Bilibili's native sending-area container
  // and float a visually-matched input+button *over* it (position:fixed, glued
  // to the container's rect) so it reads like typing in the original box. If
  // that container can't be located (e.g. Bilibili collapsed it entirely), we
  // fall back to a small bar floating at the video player's bottom-right.
  // Idempotent: no-op if already mounted.
  function ensureOverlayInputMounted(): void {
    if (overlayInputHost?.isConnected) {
      return;
    }
    const sendingArea = querySelector(SENDING_AREA_SELECTORS);
    const anchor = isElementUsable(sendingArea)
      ? sendingArea
      : querySelector(VIDEO_AREA_SELECTORS);
    if (!anchor) {
      // Nothing to anchor to yet (player not ready); the periodic check retries.
      return;
    }
    // Whether we managed to sit over the real native input slot, or had to fall
    // back to the player corner. Drives positioning + a subtle style tweak.
    const overNativeSlot = isElementUsable(sendingArea);

    overlayInputHost = document.createElement("div");
    overlayInputHost.className = "bsp-overlay-chat";
    // position:fixed + viewport coordinates so we never mutate Bilibili's own
    // inline styles (mutating them previously broke the page's rendering).
    Object.assign(overlayInputHost.style, {
      position: "fixed",
      display: "inline-flex",
      alignItems: "center",
      gap: "0",
      height: "32px",
      zIndex: "100",
      boxSizing: "border-box",
    } as CSSStyleDeclaration);

    overlayInput = document.createElement("input");
    overlayInput.type = "text";
    overlayInput.placeholder = "发送到房间（弹幕已关闭）";
    overlayInput.maxLength = 500;
    Object.assign(overlayInput.style, {
      height: "100%",
      flex: "1 1 auto",
      minWidth: "0",
      border: "1px solid rgba(255,255,255,0.35)",
      borderRight: "none",
      borderRadius: "6px 0 0 6px",
      padding: "0 12px",
      fontSize: "13px",
      color: "#fff",
      background: "rgba(20,20,20,0.72)",
      outline: "none",
      fontFamily: "inherit",
      boxSizing: "border-box",
    } as CSSStyleDeclaration);
    overlayInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        void handleSendToRoom();
      }
    });

    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "发送到房间";
    btn.title = "把内容发送给同房间的人（弹幕已关闭时可用）";
    Object.assign(btn.style, {
      height: "100%",
      flex: "0 0 auto",
      background: BILI_PINK,
      color: "#fff",
      border: "none",
      borderRadius: "0 6px 6px 0",
      padding: "0 14px",
      fontSize: "13px",
      fontWeight: "500",
      cursor: "pointer",
      whiteSpace: "nowrap",
      transition: "background 0.15s",
      fontFamily: "inherit",
      boxSizing: "border-box",
    } as CSSStyleDeclaration);
    btn.addEventListener("mouseenter", () => {
      btn.style.background = "#E85A8B";
    });
    btn.addEventListener("mouseleave", () => {
      btn.style.background = BILI_PINK;
    });
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void handleSendToRoom();
    });

    overlayInputHost.appendChild(overlayInput);
    overlayInputHost.appendChild(btn);
    document.body.appendChild(overlayInputHost);

    overlayAnchor = anchor;
    updateOverlayInputPosition(overNativeSlot);

    // Keep the overlay glued to the anchor as the layout shifts.
    overlayInputResizeObserver = new ResizeObserver(() =>
      updateOverlayInputPosition(overNativeSlot),
    );
    overlayInputResizeObserver.observe(anchor);
    window.addEventListener("scroll", handleOverlayInputReflow, {
      passive: true,
    });
    window.addEventListener("resize", handleOverlayInputReflow, {
      passive: true,
    });
  }

  // Recomputes the overlay input's fixed position from its anchor's rect.
  // overNativeSlot === true → cover the native sending-area exactly.
  // overNativeSlot === false → float a compact bar at the player bottom-right.
  function updateOverlayInputPosition(overNativeSlot: boolean): void {
    if (!overlayInputHost || !overlayAnchor?.isConnected) {
      return;
    }
    const rect = overlayAnchor.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }
    if (overNativeSlot) {
      // Sit exactly over the native sending-area container.
      overlayInputHost.style.left = `${rect.left}px`;
      overlayInputHost.style.top = `${rect.top}px`;
      overlayInputHost.style.width = `${rect.width}px`;
      overlayInputHost.style.height = `${rect.height}px`;
    } else {
      // Fallback: compact bar pinned to the player's bottom-right corner,
      // sitting just above the control bar (~48px tall).
      const width = Math.min(260, Math.max(200, rect.width * 0.35));
      overlayInputHost.style.width = `${width}px`;
      overlayInputHost.style.height = "34px";
      overlayInputHost.style.left = `${rect.right - width - 12}px`;
      overlayInputHost.style.top = `${rect.bottom - 48 - 34 - 8}px`;
    }
  }

  // Reflow handler bound to scroll/resize. Recomputes using the same mode we
  // mounted with (inferred from whether the anchor is the native sending area).
  function handleOverlayInputReflow(): void {
    const overNativeSlot =
      !!overlayAnchor &&
      SENDING_AREA_SELECTORS.some((sel) => overlayAnchor?.matches(sel));
    updateOverlayInputPosition(overNativeSlot);
  }

  // Removes the overlay input and its observers/listeners. Safe to call
  // repeatedly (no-op if unmounted).
  function teardownOverlayInput(): void {
    overlayInputResizeObserver?.disconnect();
    overlayInputResizeObserver = null;
    window.removeEventListener("scroll", handleOverlayInputReflow);
    window.removeEventListener("resize", handleOverlayInputReflow);
    overlayInputHost?.remove();
    overlayInputHost = null;
    overlayInput = null;
    overlayAnchor = null;
  }

  function getSendButtonHeight(sendBtn: HTMLElement): string {
    const rect = sendBtn.getBoundingClientRect();
    if (rect.height > 0) {
      return `${rect.height}px`;
    }
    const cs = window.getComputedStyle(sendBtn);
    return cs.height !== "auto" ? cs.height : "auto";
  }

  // The "to room" label is longer than "send", so we mirror the send button's
  // vertical padding to keep the baseline aligned while widening only the
  // horizontal sides. The left side stays a touch narrower than the send
  // button (so the squared left edge reads as glued to the send button's
  // rounded right edge) and the right side grows to make the button visibly
  // longer.
  function buildAdjacentButtonPadding(sendBtn: HTMLElement): string {
    const cs = window.getComputedStyle(sendBtn);
    const paddingTop = cs.paddingTop || "4px";
    const paddingBottom = cs.paddingBottom || "4px";
    const sendPaddingRight = parsePx(cs.paddingRight, 10);
    const sendPaddingLeft = parsePx(cs.paddingLeft, 10);
    const left = `${Math.max(6, Math.round(sendPaddingLeft - 2))}px`;
    const right = `${Math.round(sendPaddingRight + 6)}px`;
    return `${paddingTop} ${right} ${paddingBottom} ${left}`;
  }

  function parsePx(value: string, fallback: number): number {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function getSendButtonFontSize(sendBtn: HTMLElement): string {
    return window.getComputedStyle(sendBtn).fontSize || "13px";
  }

  function getSendButtonLineHeight(sendBtn: HTMLElement): string {
    return window.getComputedStyle(sendBtn).lineHeight || "normal";
  }

  function scheduleMountCheck(): void {
    if (mountTimer) {
      return;
    }
    mountTimer = window.setInterval(() => {
      if (!started) {
        window.clearInterval(mountTimer);
        mountTimer = 0;
        return;
      }
      ensureOverlayMounted();
      ensureInputButtonMounted();
    }, MOUNT_CHECK_MS);
  }

  async function handleSendToRoom(): Promise<void> {
    // Take the value from whichever input is currently active: the overlay
    // input (danmaku-off mode) takes precedence when mounted, otherwise the
    // native danmaku input (parasite mode). This makes sending work regardless
    // of the danmaku on/off state.
    const activeInput: HTMLInputElement | HTMLTextAreaElement | null =
      overlayInput?.isConnected ? overlayInput : inputEl;
    if (!activeInput) {
      return;
    }
    const text = activeInput.value.trim();
    if (!text) {
      return;
    }
    // Clear the input immediately so the user gets quick feedback
    activeInput.value = "";
    try {
      await args.runtimeSendMessage({
        type: "content:room-chat",
        text: text.slice(0, 500),
      });
    } catch {
      // ignore
    }
  }

  function showDanmaku(payload: {
    memberId: string;
    displayName: string;
    text: string;
  }): void {
    if (!overlay) {
      return;
    }
    const color = getMemberColor(payload.memberId);
    const item = document.createElement("div");
    item.className = "bsp-danmaku-item";
    item.style.borderColor = color;

    const nick = document.createElement("span");
    nick.className = "bsp-danmaku-nick";
    nick.textContent = payload.displayName;
    nick.style.color = color;

    const text = document.createElement("span");
    text.textContent = payload.text;

    item.appendChild(nick);
    item.appendChild(text);

    const top = (danmakuCount % 5) * (DANMAKU_FONT_SIZE + 10) + 8;
    item.style.top = `${top}px`;
    item.style.left = "100%";

    overlay.appendChild(item);

    const containerWidth = overlay.clientWidth;
    const itemWidth = item.offsetWidth;
    const distance = containerWidth + itemWidth + 20;
    const duration = distance / DANMAKU_SPEED_PX_PER_SEC;

    void item.offsetWidth;

    item.style.transition = `transform ${duration}s linear`;
    item.style.transform = `translateX(-${distance}px)`;

    danmakuItems.push(item);
    danmakuCount++;

    while (danmakuItems.length > MAX_DANMAKU_ITEMS) {
      const old = danmakuItems.shift();
      old?.remove();
    }

    window.setTimeout(
      () => {
        const idx = danmakuItems.indexOf(item);
        if (idx >= 0) {
          danmakuItems.splice(idx, 1);
        }
        item.remove();
      },
      duration * 1000 + 200,
    );
  }

  return {
    start() {
      if (started) {
        return;
      }
      started = true;
      ensureOverlayMounted();
      ensureInputButtonMounted();
    },
    setRoomActive(active: boolean) {
      if (roomActive === active) {
        return;
      }
      roomActive = active;
      // Re-evaluate immediately so the button/overlay appears or disappears
      // right away instead of waiting for the next periodic mount check.
      ensureInputButtonMounted();
    },
    handleRoomChat(payload) {
      showDanmaku(payload);
    },
    destroy() {
      started = false;
      if (mountTimer) {
        window.clearInterval(mountTimer);
        mountTimer = 0;
      }
      for (const item of danmakuItems) {
        item.remove();
      }
      danmakuItems.length = 0;
      // Tear down both input modes: the parasite button (restoring the native
      // send button's corners) and the overlay fallback input.
      teardownParasiteButton();
      teardownOverlayInput();
      overlayResizeObserver?.disconnect();
      overlayResizeObserver = null;
      window.removeEventListener("scroll", updateOverlayPosition);
      window.removeEventListener("resize", updateOverlayPosition);
      overlayHost?.remove();
      overlayHost = null;
      overlay = null;
      currentVideoArea = null;
    },
  };
}
