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

// Detects whether Bilibili's native danmaku input is truly usable right now.
// When the user turns danmaku off, Bilibili either removes the input, disables
// it, or collapses it to zero size — any of which means we can no longer
// piggy-back on it and must fall back to our own overlay input.
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
  // is unavailable (danmaku turned off). To avoid covering video unnecessarily,
  // it defaults to a small pink dot pinned to the player's bottom-right corner;
  // clicking the dot expands an input + send button. Enter sends, Esc / outside
  // click / blur collapses it back to the dot. Guarantees the user can always
  // send to the room regardless of the danmaku on/off state, in windowed and
  // fullscreen modes alike.
  let overlayRoot: HTMLDivElement | null = null;
  let overlayDot: HTMLButtonElement | null = null;
  let overlayPanel: HTMLDivElement | null = null;
  let overlayInput: HTMLInputElement | null = null;
  let overlaySendBtn: HTMLButtonElement | null = null;
  let overlayExpanded = false;
  // The video area we pin against, plus the observer/handlers that keep the
  // overlay glued to it as the layout changes (incl. fullscreen toggles).
  let overlayVideoArea: HTMLElement | null = null;
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

  // Mounts our overlay room-chat affordance, used when the native danmaku input
  // is off/unavailable. It pins to the video player's bottom-right corner so it
  // works in both windowed and fullscreen modes (fullscreen uses a different
  // DOM subtree, which is why anchoring to the native sending-area failed
  // before). To avoid covering video, it starts as a small pink dot; clicking
  // the dot expands an input + send button. Idempotent: no-op if already mounted.
  function ensureOverlayInputMounted(): void {
    if (overlayRoot?.isConnected) {
      return;
    }
    const videoArea = querySelector(VIDEO_AREA_SELECTORS);
    if (!videoArea) {
      // Player not ready yet; the periodic mount check retries.
      return;
    }

    overlayRoot = document.createElement("div");
    overlayRoot.className = "bsp-overlay-chat";
    // position:fixed + viewport coordinates so we never mutate Bilibili's own
    // inline styles (mutating them previously broke the page's rendering).
    Object.assign(overlayRoot.style, {
      position: "fixed",
      right: "12px",
      bottom: "56px",
      zIndex: "100",
      boxSizing: "border-box",
    } as CSSStyleDeclaration);

    // --- Collapsed state: a small pink dot. ---
    overlayDot = document.createElement("button");
    overlayDot.type = "button";
    overlayDot.title = "发送到房间（弹幕已关闭）";
    overlayDot.setAttribute("aria-label", "发送到房间");
    Object.assign(overlayDot.style, {
      width: "30px",
      height: "30px",
      borderRadius: "50%",
      background: BILI_PINK,
      border: "2px solid rgba(255,255,255,0.85)",
      padding: "0",
      cursor: "pointer",
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      boxShadow: "0 1px 4px rgba(0,0,0,0.4)",
      transition: "background 0.15s, transform 0.15s",
    } as CSSStyleDeclaration);
    // A simple paper-plane-ish glyph drawn with CSS so we don't need an asset.
    const dotGlyph = document.createElement("span");
    dotGlyph.textContent = "✈";
    dotGlyph.style.cssText =
      "font-size:14px;color:#fff;line-height:1;pointer-events:none;";
    overlayDot.appendChild(dotGlyph);
    overlayDot.addEventListener("mouseenter", () => {
      if (!overlayDot) {
        return;
      }
      overlayDot.style.background = "#E85A8B";
      overlayDot.style.transform = "scale(1.08)";
    });
    overlayDot.addEventListener("mouseleave", () => {
      if (!overlayDot) {
        return;
      }
      overlayDot.style.background = BILI_PINK;
      overlayDot.style.transform = "scale(1)";
    });
    overlayDot.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      expandOverlay();
    });

    // --- Expanded state: input + send button. Hidden until the dot is clicked. ---
    overlayPanel = document.createElement("div");
    Object.assign(overlayPanel.style, {
      display: "none",
      alignItems: "center",
      gap: "0",
      height: "34px",
      boxSizing: "border-box",
    } as CSSStyleDeclaration);

    overlayInput = document.createElement("input");
    overlayInput.type = "text";
    overlayInput.placeholder = "发送到房间…";
    overlayInput.maxLength = 500;
    Object.assign(overlayInput.style, {
      height: "100%",
      width: "180px",
      border: "1px solid rgba(255,255,255,0.35)",
      borderRight: "none",
      borderRadius: "6px 0 0 6px",
      padding: "0 12px",
      fontSize: "13px",
      color: "#fff",
      background: "rgba(20,20,20,0.8)",
      outline: "none",
      fontFamily: "inherit",
      boxSizing: "border-box",
    } as CSSStyleDeclaration);
    overlayInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        void handleSendToRoom();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        collapseOverlay();
      }
    });
    // Collapse when the user clicks elsewhere (so the dot comes back instead of
    // the panel sitting open over the video forever).
    overlayInput.addEventListener("blur", (e) => {
      // Don't collapse if focus moved to our own send button (clicking it would
      // then re-trigger). Use a microtask so the click on the button lands first.
      const related = e.relatedTarget as Node | null;
      if (related === overlaySendBtn) {
        return;
      }
      window.setTimeout(() => {
        if (
          overlayExpanded &&
          overlayInput &&
          document.activeElement !== overlayInput
        ) {
          collapseOverlay();
        }
      }, 0);
    });

    overlaySendBtn = document.createElement("button");
    overlaySendBtn.type = "button";
    overlaySendBtn.textContent = "发送";
    overlaySendBtn.title = "把内容发送给同房间的人";
    Object.assign(overlaySendBtn.style, {
      height: "100%",
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
    overlaySendBtn.addEventListener("mouseenter", () => {
      if (overlaySendBtn) {
        overlaySendBtn.style.background = "#E85A8B";
      }
    });
    overlaySendBtn.addEventListener("mouseleave", () => {
      if (overlaySendBtn) {
        overlaySendBtn.style.background = BILI_PINK;
      }
    });
    overlaySendBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void handleSendToRoom();
    });

    overlayPanel.appendChild(overlayInput);
    overlayPanel.appendChild(overlaySendBtn);
    overlayRoot.appendChild(overlayDot);
    overlayRoot.appendChild(overlayPanel);
    document.body.appendChild(overlayRoot);

    overlayVideoArea = videoArea;
    overlayExpanded = false;
    updateOverlayInputPosition();

    // Keep the overlay pinned to the player's bottom-right as the layout
    // shifts (resize, fullscreen toggle, SPA navigation).
    overlayInputResizeObserver = new ResizeObserver(() =>
      updateOverlayInputPosition(),
    );
    overlayInputResizeObserver.observe(videoArea);
    window.addEventListener("scroll", updateOverlayInputPosition, {
      passive: true,
    });
    window.addEventListener("resize", updateOverlayInputPosition, {
      passive: true,
    });
  }

  // Shows the input panel (and hides the dot). Focuses the input so the user
  // can type immediately.
  function expandOverlay(): void {
    if (!overlayDot || !overlayPanel || !overlayInput) {
      return;
    }
    overlayExpanded = true;
    overlayDot.style.display = "none";
    overlayPanel.style.display = "inline-flex";
    overlayInput.focus();
  }

  // Hides the input panel (and brings the dot back). Clears any typed text so a
  // later expansion starts fresh.
  function collapseOverlay(): void {
    if (!overlayDot || !overlayPanel || !overlayInput) {
      return;
    }
    overlayExpanded = false;
    overlayPanel.style.display = "none";
    overlayDot.style.display = "inline-flex";
    overlayInput.value = "";
  }

  // Repositions the overlay root against the video area's current rect. We stay
  // glued to the bottom-right corner, sitting just above the control bar. If the
  // video area can't be measured we just leave the last position in place.
  function updateOverlayInputPosition(): void {
    if (!overlayRoot || !overlayVideoArea?.isConnected) {
      return;
    }
    const rect = overlayVideoArea.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }
    // Sit 12px in from the right edge, 56px up from the bottom (clears the
    // ~48px control bar + a little breathing room).
    const right = Math.max(0, window.innerWidth - rect.right) + 12;
    const bottom = Math.max(0, window.innerHeight - rect.bottom) + 56;
    overlayRoot.style.right = `${right}px`;
    overlayRoot.style.bottom = `${bottom}px`;
  }

  // Removes the overlay and its observers/listeners. Safe to call repeatedly.
  function teardownOverlayInput(): void {
    overlayInputResizeObserver?.disconnect();
    overlayInputResizeObserver = null;
    window.removeEventListener("scroll", updateOverlayInputPosition);
    window.removeEventListener("resize", updateOverlayInputPosition);
    overlayRoot?.remove();
    overlayRoot = null;
    overlayDot = null;
    overlayPanel = null;
    overlayInput = null;
    overlaySendBtn = null;
    overlayVideoArea = null;
    overlayExpanded = false;
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
    // If we just sent from the expanded overlay, collapse it back to the dot so
    // it stops covering the video. (Native parasite mode has no collapsed state.)
    if (activeInput === overlayInput && overlayExpanded) {
      collapseOverlay();
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
