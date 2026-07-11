/**
 * Danmaku chat — a "发送至房间" button injected next to Bilibili's danmaku
 * send button. Clicking the button sends the current input text to the
 * room directly (no mode switching — the Bilibili input box is left
 * untouched so the user can still send regular danmaku with Enter).
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
    const input = querySelector(INPUT_SELECTORS);
    const sendBtn = querySelector(SEND_BTN_SELECTORS);

    if (!input && !sendBtn) {
      scheduleMountCheck();
      return;
    }

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
    if (!inputEl) {
      return;
    }
    const text = inputEl.value.trim();
    if (!text) {
      return;
    }
    // Clear the input immediately so the user gets quick feedback
    inputEl.value = "";
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
      roomButton?.remove();
      roomButton = null;
      // Restore the send button's original right-side rounding we squared off.
      if (
        sendBtnEl instanceof HTMLElement &&
        sendBtnOriginalBorderRadius !== null
      ) {
        sendBtnEl.style.borderRadius = sendBtnOriginalBorderRadius;
      }
      sendBtnOriginalBorderRadius = null;
      overlayResizeObserver?.disconnect();
      overlayResizeObserver = null;
      window.removeEventListener("scroll", updateOverlayPosition);
      window.removeEventListener("resize", updateOverlayPosition);
      overlayHost?.remove();
      overlayHost = null;
      overlay = null;
      currentVideoArea = null;
      inputEl = null;
      sendBtnEl = null;
    },
  };
}
