import type {
  ActiveVideoResponsePayload,
  ContentToBackgroundMessage,
} from "../shared/messages";
import {
  isShareContextResponse,
  isShareCurrentVideoResponse,
} from "../shared/messages";
import { t } from "../shared/i18n";
import {
  loadPageShareButtonPosition,
  savePageShareButtonPosition,
  type PageShareButtonPosition,
} from "../shared/storage";
import { areSharedVideoUrlsEqual } from "../shared/url";

type RuntimeSendMessage = <T>(
  message: ContentToBackgroundMessage,
) => Promise<T | null>;

export type PageShareActionResult =
  | "shared"
  | "cancelled"
  | "no-video"
  | "context-error"
  | "share-error";

export async function shareCurrentPageVideoFromContent(args: {
  resolveCurrentSharePayload: () => Promise<ActiveVideoResponsePayload | null>;
  runtimeSendMessage: RuntimeSendMessage;
  confirm: (message: string) => boolean;
  showToast: (message: string) => void;
}): Promise<PageShareActionResult> {
  try {
    const payload = await args.resolveCurrentSharePayload();
    if (!payload) {
      args.showToast(t("popupErrorNoPlayableVideo"));
      return "no-video";
    }

    const contextResponse = await args.runtimeSendMessage<unknown>({
      type: "content:get-share-context",
    });
    if (!isShareContextResponse(contextResponse) || !contextResponse.ok) {
      const error = isShareContextResponse(contextResponse)
        ? contextResponse.error
        : undefined;
      args.showToast(
        t("pageShareFailed", {
          error: error ?? t("popupErrorCannotReadCurrentVideo"),
        }),
      );
      return "context-error";
    }

    if (!contextResponse.roomCode) {
      const shouldCreateRoom = args.confirm(t("confirmCreateRoomBeforeShare"));
      if (!shouldCreateRoom) {
        return "cancelled";
      }
    } else if (
      contextResponse.sharedVideo?.url &&
      !areSharedVideoUrlsEqual(
        contextResponse.sharedVideo.url,
        payload.video.url,
      )
    ) {
      const shouldReplace = args.confirm(
        t("confirmReplaceSharedVideo", {
          currentTitle: contextResponse.sharedVideo.title,
          nextTitle: payload.video.title,
        }),
      );
      if (!shouldReplace) {
        return "cancelled";
      }
    }

    const shareResponse = await args.runtimeSendMessage<unknown>({
      type: "content:share-current-video",
    });
    if (!isShareCurrentVideoResponse(shareResponse) || !shareResponse.ok) {
      const error = isShareCurrentVideoResponse(shareResponse)
        ? shareResponse.error
        : undefined;
      args.showToast(
        t("pageShareFailed", {
          error: error ?? t("popupErrorCannotReadCurrentVideo"),
        }),
      );
      return "share-error";
    }

    args.showToast(t("pageShareSuccess"));
    return "shared";
  } catch (error) {
    args.showToast(
      t("pageShareFailed", {
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return "share-error";
  }
}

export interface PageShareButtonController {
  start(): void;
  setEnabled(enabled: boolean): void;
  resetMountTarget(): void;
  destroy(): void;
}

const BUTTON_SIZE = 36;
const EDGE_MARGIN = 12;
const DEFAULT_RIGHT_OFFSET = 20;
const DEFAULT_BOTTOM_OFFSET = 80;
const DRAG_THRESHOLD_PX = 4;
const WEB_FULLSCREEN_SELECTORS = [
  ".bilibili-player.mode-fullscreen",
  ".bilibili-player.mode-webfullscreen",
  ".bilibili-player.mode-webscreen",
  ".bilibili-player-video-wrap-fullscreen",
  ".bilibili-player-video-wrap-web-fullscreen",
  ".bpx-player-container[data-screen='full']",
  ".bpx-player-container[data-screen='fullscreen']",
  ".bpx-player-container[data-screen='web']",
  ".bpx-player-container[data-screen='webscreen']",
  ".bpx-player-container.bpx-state-fullscreen",
  ".bpx-player-container.bpx-state-web",
  ".bpx-player-container.bpx-state-webscreen",
].join(",");
const VIDEO_PLAYER_CONTAINER_SELECTOR =
  ".bilibili-player,.bpx-player-container";

export function clampPageShareButtonPosition(
  position: PageShareButtonPosition,
  viewport: { width: number; height: number },
  buttonSize = BUTTON_SIZE,
  edgeMargin = EDGE_MARGIN,
): PageShareButtonPosition {
  const maxX = Math.max(edgeMargin, viewport.width - buttonSize - edgeMargin);
  const maxY = Math.max(edgeMargin, viewport.height - buttonSize - edgeMargin);
  return {
    x: Math.round(Math.min(Math.max(position.x, edgeMargin), maxX)),
    y: Math.round(Math.min(Math.max(position.y, edgeMargin), maxY)),
  };
}

export function getDefaultPageShareButtonPosition(
  viewport: { width: number; height: number },
  buttonSize = BUTTON_SIZE,
): PageShareButtonPosition {
  return clampPageShareButtonPosition(
    {
      x: viewport.width - buttonSize - DEFAULT_RIGHT_OFFSET,
      y: viewport.height - buttonSize - DEFAULT_BOTTOM_OFFSET,
    },
    viewport,
    buttonSize,
  );
}

export function hasPageShareButtonDragMoved(
  deltaX: number,
  deltaY: number,
): boolean {
  return Math.hypot(deltaX, deltaY) >= DRAG_THRESHOLD_PX;
}

export function isBilibiliVideoFullscreenActive(): boolean {
  if (document.fullscreenElement) {
    return true;
  }
  if (document.querySelector(WEB_FULLSCREEN_SELECTORS)) {
    return true;
  }
  const player = document.querySelector(VIDEO_PLAYER_CONTAINER_SELECTOR);
  if (!(player instanceof HTMLElement)) {
    return false;
  }
  const rect = player.getBoundingClientRect();
  const style = window.getComputedStyle(player);
  return (
    style.position === "fixed" &&
    rect.width >= window.innerWidth - 2 &&
    rect.height >= window.innerHeight - 2
  );
}

export function createPageShareButtonController(args: {
  resolveCurrentSharePayload: () => Promise<ActiveVideoResponsePayload | null>;
  runtimeSendMessage: RuntimeSendMessage;
  toastPresenter: { show(message: string): void };
  confirm?: (message: string) => boolean;
  loadPosition?: () => Promise<PageShareButtonPosition | null>;
  savePosition?: (position: PageShareButtonPosition) => Promise<void>;
  isFullscreenActive?: () => boolean;
}): PageShareButtonController {
  let host: HTMLDivElement | null = null;
  let button: HTMLButtonElement | null = null;
  let enabled = true;
  let pending = false;
  let started = false;
  let position: PageShareButtonPosition | null = null;
  let animationFrame = 0;
  let fullscreenObserver: MutationObserver | null = null;
  let suppressNextClick = false;
  let dragState: {
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startPosition: PageShareButtonPosition;
    moved: boolean;
  } | null = null;

  function getViewport(): { width: number; height: number } {
    return {
      width: window.innerWidth || document.documentElement.clientWidth,
      height: window.innerHeight || document.documentElement.clientHeight,
    };
  }

  function getCurrentPosition(): PageShareButtonPosition {
    const viewport = getViewport();
    return clampPageShareButtonPosition(
      position ?? getDefaultPageShareButtonPosition(viewport),
      viewport,
    );
  }

  function render(): void {
    if (!button) {
      return;
    }
    const nextPosition = getCurrentPosition();
    button.style.left = `${nextPosition.x}px`;
    button.style.top = `${nextPosition.y}px`;
    button.disabled = pending;
    button.title = t("actionShareCurrentVideo");
    button.setAttribute("aria-label", t("actionShareCurrentVideo"));
    button.setAttribute("aria-busy", pending ? "true" : "false");
  }

  function removeHost(): void {
    host?.remove();
    host = null;
    button = null;
    dragState = null;
  }

  function scheduleMountRefresh(): void {
    if (animationFrame) {
      return;
    }
    animationFrame = window.requestAnimationFrame(() => {
      animationFrame = 0;
      ensureMounted();
    });
  }

  function isFullscreenActive(): boolean {
    return args.isFullscreenActive?.() ?? isBilibiliVideoFullscreenActive();
  }

  async function handleClick(): Promise<void> {
    if (pending) {
      return;
    }
    pending = true;
    render();
    try {
      await shareCurrentPageVideoFromContent({
        resolveCurrentSharePayload: args.resolveCurrentSharePayload,
        runtimeSendMessage: args.runtimeSendMessage,
        confirm:
          args.confirm ??
          ((message) => {
            return window.confirm(message);
          }),
        showToast: (message) => args.toastPresenter.show(message),
      });
    } finally {
      pending = false;
      render();
    }
  }

  function ensureMounted(): void {
    if (!started || !enabled || isFullscreenActive()) {
      removeHost();
      return;
    }
    const mountTarget = document.body;
    if (!mountTarget) {
      return;
    }
    if (host?.isConnected && host.parentElement === mountTarget && button) {
      render();
      return;
    }

    removeHost();

    host = document.createElement("div");
    host.style.position = "fixed";
    host.style.inset = "0";
    host.style.pointerEvents = "none";
    host.style.zIndex = "2147482999";

    const shadowRoot = host.attachShadow({ mode: "open" });
    shadowRoot.innerHTML = `
      <style>
        :host {
          all: initial;
        }
        .share-button {
          position: absolute;
          width: ${BUTTON_SIZE}px;
          height: ${BUTTON_SIZE}px;
          padding: 0;
          border: 0;
          border-radius: 999px;
          background: #ff5a8a;
          color: #ffffff;
          box-shadow: 0 8px 18px rgba(255, 90, 138, 0.28), 0 2px 8px rgba(27, 31, 45, 0.16);
          box-sizing: border-box;
          cursor: grab;
          pointer-events: auto;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          touch-action: none;
          transition: background 0.16s ease, opacity 0.16s ease, transform 0.16s ease;
        }
        .share-button svg {
          width: 20px;
          height: 20px;
          display: block;
          pointer-events: none;
        }
        .share-button:hover {
          background: #ff4b81;
          transform: translateY(-1px);
        }
        .share-button:active,
        .share-button.is-dragging {
          cursor: grabbing;
          transform: translateY(0);
        }
        .share-button:focus-visible {
          outline: 3px solid rgba(255, 90, 138, 0.28);
          outline-offset: 2px;
        }
        .share-button:disabled {
          cursor: default;
          opacity: 0.72;
          transform: none;
        }
        .share-button[aria-busy="true"] svg {
          animation: spin 0.8s linear infinite;
        }
        @keyframes spin {
          to {
            transform: rotate(360deg);
          }
        }
        @media (prefers-color-scheme: dark) {
          .share-button {
            background: #ff6b96;
            box-shadow: 0 8px 18px rgba(255, 107, 150, 0.24), 0 2px 10px rgba(0, 0, 0, 0.28);
          }
          .share-button:hover {
            background: #ff7aa1;
          }
        }
      </style>
      <button class="share-button" type="button">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path fill="currentColor" d="M21 0H3a3 3 0 0 0-3 3v9a3 3 0 0 0 3 3h18a3 3 0 0 0 3-3V3a3 3 0 0 0-3-3m1 12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h18a1 1 0 0 1 1 1Z"></path>
          <path fill="currentColor" d="M9.54 3.79a.37.37 0 0 0-.41 0a.6.6 0 0 0-.19.45v6.42a.6.6 0 0 0 .19.45a.37.37 0 0 0 .41.05l5.58-2.94a.88.88 0 0 0 0-1.53ZM4.5 18a3 3 0 0 0-3 3v2.5a.5.5 0 0 0 .5.5h5a.5.5 0 0 0 .5-.5V21a3 3 0 0 0-3-3m7.5 0a3 3 0 0 0-3 3v2.5a.5.5 0 0 0 .5.5h5a.5.5 0 0 0 .5-.5V21a3 3 0 0 0-3-3m7.5 0a3 3 0 0 0-3 3v2.5a.5.5 0 0 0 .5.5h5a.5.5 0 0 0 .5-.5V21a3 3 0 0 0-3-3"></path>
        </svg>
      </button>
    `;
    button = shadowRoot.querySelector("button");
    button?.addEventListener("pointerdown", handlePointerDown);
    button?.addEventListener("pointermove", handlePointerMove);
    button?.addEventListener("pointerup", handlePointerUp);
    button?.addEventListener("pointercancel", handlePointerCancel);
    button?.addEventListener("click", (event) => {
      if (suppressNextClick) {
        suppressNextClick = false;
        event.preventDefault();
        return;
      }
      void handleClick();
    });
    mountTarget.appendChild(host);
    render();
  }

  function handlePointerDown(event: PointerEvent): void {
    if (!button || pending || event.button !== 0) {
      return;
    }
    dragState = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startPosition: getCurrentPosition(),
      moved: false,
    };
    button.setPointerCapture(event.pointerId);
    button.classList.add("is-dragging");
  }

  function handlePointerMove(event: PointerEvent): void {
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }
    const deltaX = event.clientX - dragState.startClientX;
    const deltaY = event.clientY - dragState.startClientY;
    if (!dragState.moved && !hasPageShareButtonDragMoved(deltaX, deltaY)) {
      return;
    }
    event.preventDefault();
    dragState.moved = true;
    position = clampPageShareButtonPosition(
      {
        x: dragState.startPosition.x + deltaX,
        y: dragState.startPosition.y + deltaY,
      },
      getViewport(),
    );
    render();
  }

  function handlePointerUp(event: PointerEvent): void {
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }
    const didMove = dragState.moved;
    dragState = null;
    button?.classList.remove("is-dragging");
    if (button?.hasPointerCapture(event.pointerId)) {
      button.releasePointerCapture(event.pointerId);
    }
    if (!didMove || !position) {
      return;
    }
    suppressNextClick = true;
    void (args.savePosition ?? savePageShareButtonPosition)(position).catch(
      () => undefined,
    );
  }

  function handlePointerCancel(event: PointerEvent): void {
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }
    dragState = null;
    button?.classList.remove("is-dragging");
    if (button?.hasPointerCapture(event.pointerId)) {
      button.releasePointerCapture(event.pointerId);
    }
  }

  function startFullscreenObserver(): void {
    if (fullscreenObserver || typeof MutationObserver === "undefined") {
      return;
    }
    fullscreenObserver = new MutationObserver(scheduleMountRefresh);
    fullscreenObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-screen", "style"],
      subtree: true,
    });
  }

  return {
    start() {
      if (started) {
        ensureMounted();
        return;
      }
      started = true;
      window.addEventListener("resize", scheduleMountRefresh);
      startFullscreenObserver();
      void (args.loadPosition ?? loadPageShareButtonPosition)()
        .then((storedPosition) => {
          if (!started) {
            return;
          }
          position = storedPosition;
          ensureMounted();
        })
        .catch(() => undefined);
      ensureMounted();
    },
    setEnabled(nextEnabled) {
      enabled = nextEnabled;
      ensureMounted();
    },
    resetMountTarget: ensureMounted,
    destroy() {
      started = false;
      if (animationFrame) {
        window.cancelAnimationFrame(animationFrame);
        animationFrame = 0;
      }
      fullscreenObserver?.disconnect();
      fullscreenObserver = null;
      window.removeEventListener("resize", scheduleMountRefresh);
      removeHost();
    },
  };
}
