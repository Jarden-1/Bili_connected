/**
 * Danmaku chat — injects a "Room" toggle button next to the Bilibili danmaku
 * input, and renders room chat messages as colored scrolling danmaku on top
 * of the video player.
 *
 * - Room mode: input border turns blue (#00A1D6), placeholder changes,
 *   Enter sends a room:chat message (B站原生弹幕发送被拦截).
 * - Normal mode: B站原生弹幕行为不受影响.
 * - Incoming room:chat messages render as colored danmaku (per-user color +
 *   thin border + nickname prefix) scrolling right-to-left.
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

const BILI_BLUE = "#00A1D6";
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
  "#3498DB",
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

const INPUT_WRAP_SELECTORS = [
  ".bpx-player-dm-input-wrap",
  ".bpx-player-dm-bottom",
  ".bilibili-player-video-danmaku-function-area",
  ".bpx-player-dm-function-area",
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
  let roomButton: HTMLButtonElement | null = null;
  let inputEl: HTMLElement | null = null;
  let sendBtnEl: HTMLElement | null = null;
  let started = false;
  let roomMode = false;
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
      overlayHost.style.position = "absolute";
      overlayHost.style.top = "0";
      overlayHost.style.left = "0";
      overlayHost.style.right = "0";
      overlayHost.style.bottom = "0";
      overlayHost.style.pointerEvents = "none";
      overlayHost.style.zIndex = "70";
      const shadow = overlayHost.attachShadow({ mode: "open" });
      const template = document.createElement("template");
      template.innerHTML = OVERLAY_TEMPLATE.trim();
      shadow.appendChild(template.content.cloneNode(true));
      overlay = shadow.querySelector(".bsp-danmaku-overlay");
    }
    if (videoArea.style.position === "static" || !videoArea.style.position) {
      videoArea.style.position = "relative";
    }
    videoArea.appendChild(overlayHost);
  }

  function ensureInputButtonMounted(): void {
    if (!started) {
      return;
    }
    const input = querySelector(INPUT_SELECTORS) as
      | HTMLInputElement
      | HTMLTextAreaElement
      | null;
    const sendBtn = querySelector(SEND_BTN_SELECTORS);
    const wrap = querySelector(INPUT_WRAP_SELECTORS);

    if (!input && !wrap) {
      scheduleMountCheck();
      return;
    }

    if (inputEl !== input) {
      inputEl = input;
      if (input) {
        input.addEventListener(
          "keydown",
          (e) => handleInputKeydown(e as KeyboardEvent),
          true,
        );
      }
    }

    if (sendBtnEl !== sendBtn) {
      sendBtnEl = sendBtn;
    }

    if (roomButton?.isConnected) {
      return;
    }

    const anchor = sendBtn?.parentElement ?? wrap ?? input?.parentElement;
    if (!anchor) {
      scheduleMountCheck();
      return;
    }

    roomButton = document.createElement("button");
    roomButton.type = "button";
    roomButton.textContent = "房间";
    roomButton.title = "切换为房间消息模式";
    Object.assign(roomButton.style, {
      background: BILI_PINK,
      color: "#fff",
      border: "none",
      borderRadius: "4px",
      padding: "4px 10px",
      fontSize: "12px",
      fontWeight: "600",
      cursor: "pointer",
      marginLeft: "4px",
      whiteSpace: "nowrap",
      transition: "background 0.15s, opacity 0.15s",
      fontFamily: "inherit",
    } as CSSStyleDeclaration);

    roomButton.addEventListener("mouseenter", () => {
      if (!roomButton) {
        return;
      }
      roomButton.style.opacity = "0.85";
    });
    roomButton.addEventListener("mouseleave", () => {
      if (!roomButton) {
        return;
      }
      roomButton.style.opacity = "1";
    });
    roomButton.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleRoomMode();
    });

    if (sendBtn && sendBtn.parentElement === anchor) {
      anchor.insertBefore(roomButton, sendBtn.nextSibling);
    } else {
      anchor.appendChild(roomButton);
    }
    updateInputAppearance();
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

  function toggleRoomMode(): void {
    roomMode = !roomMode;
    updateInputAppearance();
  }

  function updateInputAppearance(): void {
    if (!inputEl) {
      return;
    }
    if (roomMode) {
      inputEl.style.border = `2px solid ${BILI_BLUE}`;
      inputEl.style.borderRadius = "4px";
      inputEl.style.boxShadow = `0 0 0 2px rgba(0,161,214,0.15)`;
      if (inputEl instanceof HTMLInputElement ||
          inputEl instanceof HTMLTextAreaElement) {
        inputEl.placeholder = "给同房朋友说点什么...";
      }
      if (roomButton) {
        roomButton.style.background = BILI_BLUE;
        roomButton.textContent = "弹幕";
        roomButton.title = "切回普通弹幕";
      }
    } else {
      inputEl.style.border = "";
      inputEl.style.borderRadius = "";
      inputEl.style.boxShadow = "";
      if (inputEl instanceof HTMLInputElement ||
          inputEl instanceof HTMLTextAreaElement) {
        inputEl.placeholder = "";
      }
      if (roomButton) {
        roomButton.style.background = BILI_PINK;
        roomButton.textContent = "房间";
        roomButton.title = "切换为房间消息模式";
      }
    }
  }

  function handleInputKeydown(e: KeyboardEvent): void {
    if (!roomMode || e.key !== "Enter") {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const input = e.target as
      | HTMLInputElement
      | HTMLTextAreaElement
      | null;
    if (!input) {
      return;
    }
    const text = input.value.trim();
    if (!text) {
      return;
    }
    input.value = "";
    void args.runtimeSendMessage({
      type: "content:room-chat",
      text: text.slice(0, 500),
    });
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

    window.setTimeout(() => {
      const idx = danmakuItems.indexOf(item);
      if (idx >= 0) {
        danmakuItems.splice(idx, 1);
      }
      item.remove();
    }, duration * 1000 + 200);
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
      roomMode = false;
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
      overlayHost?.remove();
      overlayHost = null;
      overlay = null;
      inputEl = null;
      sendBtnEl = null;
    },
  };
}
