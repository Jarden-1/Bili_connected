import type {
  ActiveVideoResponsePayload,
  ContentToBackgroundMessage,
  ShareContextResponse,
} from "../shared/messages";
import {
  isPageShareButtonSettingsResponse,
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
import { setShadowRootTemplate } from "./shadow-template";

type RuntimeSendMessage = <T>(
  message: ContentToBackgroundMessage,
) => Promise<T | null>;

export type PageShareActionResult =
  "shared" | "cancelled" | "no-video" | "context-error" | "share-error";

export interface PageSharePopoverViewModel {
  status: string | null;
  joined: boolean;
  roomCode: string | null;
  joinToken: string | null;
  members: Array<{ id: string; name: string }>;
  displayName: string | null;
  sharedVideoTitle: string | null;
}

export function createPageSharePopoverViewModel(args: {
  loading: boolean;
  error: string | null;
  context: ShareContextResponse | null;
}): PageSharePopoverViewModel {
  if (args.loading) {
    return {
      status: t("pageSharePopoverLoading"),
      joined: false,
      roomCode: null,
      joinToken: null,
      members: [],
      displayName: null,
      sharedVideoTitle: null,
    };
  }
  if (args.error) {
    return {
      status: args.error,
      joined: false,
      roomCode: null,
      joinToken: null,
      members: [],
      displayName: null,
      sharedVideoTitle: null,
    };
  }
  if (!args.context?.roomCode) {
    return {
      status: t("pageShareRoomNotJoined"),
      joined: false,
      roomCode: null,
      joinToken: null,
      members: [],
      displayName: null,
      sharedVideoTitle: null,
    };
  }
  return {
    status: null,
    joined: true,
    roomCode: args.context.roomCode,
    joinToken: args.context.joinToken ?? null,
    members: args.context.members,
    displayName: args.context.displayName,
    sharedVideoTitle:
      args.context.sharedVideo?.title ?? t("pageShareNoSharedVideo"),
  };
}

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
const POPOVER_WIDTH = 228;
const POPOVER_ESTIMATED_HEIGHT = 146;
const POPOVER_GAP = 10;
const POPOVER_HIDE_DELAY_MS = 140;
const QUICK_CREATE_SETTLE_DELAY_MS = 800;
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

export function getPageSharePopoverPosition(
  buttonPosition: PageShareButtonPosition,
  viewport: { width: number; height: number },
  buttonSize = BUTTON_SIZE,
  popoverWidth = POPOVER_WIDTH,
  popoverHeight = POPOVER_ESTIMATED_HEIGHT,
  edgeMargin = EDGE_MARGIN,
): PageShareButtonPosition {
  const fitsRight =
    buttonPosition.x + buttonSize + POPOVER_GAP + popoverWidth <=
    viewport.width - edgeMargin;
  const preferredX = fitsRight
    ? buttonPosition.x + buttonSize + POPOVER_GAP
    : buttonPosition.x - popoverWidth - POPOVER_GAP;
  const maxX = Math.max(edgeMargin, viewport.width - popoverWidth - edgeMargin);
  const maxY = Math.max(
    edgeMargin,
    viewport.height - popoverHeight - edgeMargin,
  );
  return {
    x: Math.round(Math.min(Math.max(preferredX, edgeMargin), maxX)),
    y: Math.round(
      Math.min(
        Math.max(
          buttonPosition.y + buttonSize / 2 - popoverHeight / 2,
          edgeMargin,
        ),
        maxY,
      ),
    ),
  };
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
  let popover: HTMLDivElement | null = null;
  let popoverStatus: HTMLParagraphElement | null = null;
  let popoverToggle: HTMLInputElement | null = null;
  let joinSection: HTMLDivElement | null = null;
  let joinForm: HTMLFormElement | null = null;
  let joinInput: HTMLInputElement | null = null;
  let _joinButton: HTMLButtonElement | null = null;
  let joinError: HTMLParagraphElement | null = null;
  let quickCreateButton: HTMLButtonElement | null = null;
  let joinedSection: HTMLDivElement | null = null;
  let roomCodeValueEl: HTMLSpanElement | null = null;
  let copyButton: HTMLButtonElement | null = null;
  let sharedVideoValueEl: HTMLSpanElement | null = null;
  let nicknameValueEl: HTMLSpanElement | null = null;
  let editNicknameButton: HTMLButtonElement | null = null;
  let nicknameInput: HTMLInputElement | null = null;
  let nicknameError: HTMLParagraphElement | null = null;
  let membersHeadingEl: HTMLSpanElement | null = null;
  let membersList: HTMLUListElement | null = null;
  let leaveButton: HTMLButtonElement | null = null;
  let enabled = false;
  let pending = false;
  let settingsPending = false;
  let joinPending = false;
  let leavePending = false;
  let quickCreatePending = false;
  let nicknameEditing = false;
  let nicknameInputFocused = false;
  let copyButtonState: "idle" | "copied" = "idle";
  let copyButtonResetTimer = 0;
  let joinErrorMessage: string | null = null;
  let nicknameErrorMessage: string | null = null;
  let started = false;
  let position: PageShareButtonPosition | null = null;
  let animationFrame = 0;
  let hidePopoverTimer = 0;
  let popoverRequestSeq = 0;
  let popoverVisible = false;
  let popoverLoading = false;
  let popoverError: string | null = null;
  let popoverContext: ShareContextResponse | null = null;
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

  function clearPopoverHideTimer(): void {
    if (!hidePopoverTimer) {
      return;
    }
    window.clearTimeout(hidePopoverTimer);
    hidePopoverTimer = 0;
  }

  function renderPopover(buttonPosition: PageShareButtonPosition): void {
    if (!popover || !popoverStatus || !popoverToggle) {
      return;
    }

    const popoverPosition = getPageSharePopoverPosition(
      buttonPosition,
      getViewport(),
    );
    popover.style.left = `${popoverPosition.x}px`;
    popover.style.top = `${popoverPosition.y}px`;
    popover.hidden = !popoverVisible;
    popover.classList.toggle("is-visible", popoverVisible);
    popoverToggle.checked = enabled;
    popoverToggle.disabled = settingsPending;

    const viewModel = createPageSharePopoverViewModel({
      loading: popoverLoading,
      error: popoverError,
      context: popoverContext,
    });

    popoverStatus.hidden = !viewModel.status;
    popoverStatus.textContent = viewModel.status ?? "";

    renderJoinSection(viewModel);
    renderJoinedSection(viewModel);
  }

  function renderJoinSection(viewModel: PageSharePopoverViewModel): void {
    if (!joinSection) {
      return;
    }
    const showJoin = !popoverLoading && !viewModel.joined;
    joinSection.hidden = !showJoin;
    if (showJoin && joinInput && !joinPending) {
      // Don't steal focus on every render — only when the popover first
      // transitions to the join form, so the user can keep using the page.
    }
    if (joinError) {
      joinError.hidden = !joinErrorMessage;
      joinError.textContent = joinErrorMessage ?? "";
    }
    if (quickCreateButton) {
      quickCreateButton.disabled = quickCreatePending || joinPending;
      quickCreateButton.textContent = quickCreatePending
        ? t("pageShareQuickCreatePending")
        : t("pageShareQuickCreate");
    }
  }

  function renderJoinedSection(viewModel: PageSharePopoverViewModel): void {
    if (!joinedSection) {
      return;
    }
    const showJoined = !popoverLoading && viewModel.joined;
    joinedSection.hidden = !showJoined;
    if (!showJoined) {
      return;
    }
    if (roomCodeValueEl) {
      roomCodeValueEl.textContent = viewModel.roomCode ?? "";
      roomCodeValueEl.title = viewModel.roomCode ?? "";
    }
    if (copyButton) {
      copyButton.disabled = copyButtonState !== "idle";
      copyButton.classList.toggle("is-copied", copyButtonState === "copied");
      copyButton.textContent =
        copyButtonState === "copied"
          ? t("pageShareRoomCodeCopied")
          : t("pageShareRoomCodeCopy");
    }
    if (sharedVideoValueEl) {
      const title = viewModel.sharedVideoTitle?.trim() || "";
      sharedVideoValueEl.textContent = title || t("pageShareNoSharedVideo");
      sharedVideoValueEl.title = title;
      sharedVideoValueEl.classList.toggle("is-empty", !title);
    }
    if (nicknameValueEl) {
      const nick = viewModel.displayName?.trim() || "";
      nicknameValueEl.textContent = nick;
      nicknameValueEl.title = nick;
    }
    if (nicknameValueEl) {
      nicknameValueEl.hidden = nicknameEditing;
    }
    if (editNicknameButton) {
      editNicknameButton.textContent = nicknameEditing
        ? t("pageShareNicknameCancel")
        : t("pageShareNicknameEdit");
    }
    if (nicknameInput) {
      nicknameInput.hidden = !nicknameEditing;
    }
    if (nicknameInput && nicknameEditing && !nicknameInputFocused) {
      nicknameInput.value = viewModel.displayName ?? "";
    }
    if (membersHeadingEl) {
      const otherCount = viewModel.members.length;
      membersHeadingEl.textContent = t("pageShareMembersHeading", {
        count: otherCount,
      });
    }
    if (membersList) {
      membersList.replaceChildren();
      if (viewModel.members.length === 0) {
        const empty = document.createElement("li");
        empty.className = "popover-member-chip";
        empty.textContent = t("pageShareNoMembers");
        membersList.appendChild(empty);
      } else {
        for (const member of viewModel.members) {
          const chip = document.createElement("li");
          chip.className = "popover-member-chip";
          chip.textContent = member.name;
          membersList.appendChild(chip);
        }
      }
    }
    if (leaveButton) {
      leaveButton.disabled = leavePending;
    }
    if (nicknameError) {
      nicknameError.hidden = !nicknameErrorMessage;
      nicknameError.textContent = nicknameErrorMessage ?? "";
    }
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
    renderPopover(nextPosition);
  }

  function removeHost(): void {
    clearPopoverHideTimer();
    if (copyButtonResetTimer) {
      window.clearTimeout(copyButtonResetTimer);
      copyButtonResetTimer = 0;
    }
    popoverRequestSeq += 1;
    popoverVisible = false;
    popoverLoading = false;
    settingsPending = false;
    joinPending = false;
    leavePending = false;
    nicknameEditing = false;
    nicknameInputFocused = false;
    copyButtonState = "idle";
    joinErrorMessage = null;
    nicknameErrorMessage = null;
    host?.remove();
    host = null;
    button = null;
    popover = null;
    popoverStatus = null;
    popoverToggle = null;
    joinSection = null;
    joinForm = null;
    joinInput = null;
    _joinButton = null;
    joinError = null;
    quickCreateButton = null;
    joinedSection = null;
    roomCodeValueEl = null;
    copyButton = null;
    sharedVideoValueEl = null;
    nicknameValueEl = null;
    editNicknameButton = null;
    nicknameInput = null;
    nicknameError = null;
    membersHeadingEl = null;
    membersList = null;
    leaveButton = null;
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

  async function refreshPopoverContext(): Promise<void> {
    const requestSeq = popoverRequestSeq + 1;
    popoverRequestSeq = requestSeq;
    popoverLoading = true;
    popoverError = null;
    render();
    try {
      const response = await args.runtimeSendMessage<unknown>({
        type: "content:get-share-context",
      });
      if (requestSeq !== popoverRequestSeq) {
        return;
      }
      popoverLoading = false;
      if (!isShareContextResponse(response) || !response.ok) {
        popoverContext = null;
        const error = isShareContextResponse(response)
          ? response.error
          : undefined;
        popoverError = error ?? t("pageSharePopoverError");
        render();
        return;
      }
      popoverContext = response;
      render();
    } catch (error) {
      if (requestSeq !== popoverRequestSeq) {
        return;
      }
      popoverLoading = false;
      popoverContext = null;
      popoverError =
        error instanceof Error ? error.message : t("pageSharePopoverError");
      render();
    }
  }

  function showPopover(options: { refresh?: boolean } = {}): void {
    if (!enabled || !started || isFullscreenActive()) {
      return;
    }
    clearPopoverHideTimer();
    popoverVisible = true;
    render();
    if (options.refresh !== false) {
      void refreshPopoverContext();
    }
  }

  function hidePopover(): void {
    clearPopoverHideTimer();
    popoverVisible = false;
    render();
  }

  function hidePopoverSoon(): void {
    clearPopoverHideTimer();
    hidePopoverTimer = window.setTimeout(() => {
      hidePopoverTimer = 0;
      hidePopover();
    }, POPOVER_HIDE_DELAY_MS);
  }

  async function handleQuickToggleChange(event: Event): Promise<void> {
    const target = event.currentTarget;
    if (!(target instanceof HTMLInputElement) || settingsPending) {
      return;
    }
    const nextEnabled = target.checked;
    settingsPending = true;
    render();
    try {
      const response = await args.runtimeSendMessage<unknown>({
        type: "content:set-page-share-button-enabled",
        enabled: nextEnabled,
      });
      if (!isPageShareButtonSettingsResponse(response) || !response.ok) {
        const error = isPageShareButtonSettingsResponse(response)
          ? response.error
          : undefined;
        args.toastPresenter.show(
          t("pageShareFailed", {
            error: error ?? t("pageSharePopoverError"),
          }),
        );
        return;
      }
      enabled = response.enabled;
      if (!enabled) {
        args.toastPresenter.show(t("pageShareButtonDisabled"));
      }
    } catch (error) {
      args.toastPresenter.show(
        t("pageShareFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      settingsPending = false;
      ensureMounted();
    }
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
      if (popoverVisible) {
        void refreshPopoverContext();
      }
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
    setShadowRootTemplate(
      shadowRoot,
      `
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
        .share-popover {
          position: absolute;
          width: ${POPOVER_WIDTH}px;
          padding: 10px;
          border: 1px solid rgba(255, 90, 138, 0.22);
          border-radius: 8px;
          background: rgba(255, 255, 255, 0.98);
          color: #242631;
          box-shadow: 0 10px 24px rgba(27, 31, 45, 0.14), 0 2px 8px rgba(27, 31, 45, 0.08);
          box-sizing: border-box;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei UI", "PingFang SC", sans-serif;
          pointer-events: auto;
          opacity: 0;
          transform: translateY(2px);
          transition: opacity 0.12s ease, transform 0.12s ease;
        }
        .share-popover[hidden] {
          display: none;
        }
        .share-popover.is-visible {
          opacity: 1;
          transform: translateY(0);
        }
        .popover-heading {
          margin: 0 0 8px;
          font-size: 13px;
          font-weight: 650;
          line-height: 18px;
        }
        .popover-status {
          margin: 0;
          color: #5b6070;
          font-size: 12px;
          line-height: 18px;
        }
        .popover-section {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .popover-section[hidden] {
          display: none;
        }
        .popover-section + .popover-section {
          margin-top: 8px;
          padding-top: 8px;
          border-top: 1px solid rgba(27, 31, 45, 0.08);
        }
        .popover-row {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 12px;
          line-height: 17px;
        }
        .popover-row-label {
          flex: 0 0 auto;
          color: #767b8c;
          font-weight: 500;
        }
        .popover-row-value {
          flex: 1 1 auto;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          color: #242631;
        }
        .popover-room-code-row {
          justify-content: space-between;
        }
        .popover-room-code-value {
          font-family: ui-monospace, "SFMono-Regular", "Menlo", monospace;
          font-weight: 600;
        }
        .popover-link-button {
          flex: 0 0 auto;
          background: none;
          border: 1px solid rgba(27, 31, 45, 0.12);
          border-radius: 4px;
          padding: 3px 8px;
          font: 500 12px/1.2 inherit;
          color: #ff5a8a;
          cursor: pointer;
          transition: background 0.15s, border-color 0.15s, color 0.15s;
        }
        .popover-link-button:hover:not(:disabled) {
          background: rgba(255, 90, 138, 0.08);
          border-color: rgba(255, 90, 138, 0.3);
        }
        .popover-link-button:focus-visible {
          outline: 2px solid rgba(255, 90, 138, 0.5);
          outline-offset: 1px;
        }
        .popover-link-button:disabled {
          opacity: 0.6;
          cursor: default;
        }
        .popover-link-button.is-copied {
          background: rgba(0, 161, 102, 0.1);
          border-color: rgba(0, 161, 102, 0.3);
          color: #00a166;
        }
        .popover-form {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .popover-input-row {
          display: flex;
          gap: 6px;
        }
        .popover-input {
          flex: 1 1 auto;
          min-width: 0;
          padding: 6px 8px;
          border: 1px solid rgba(27, 31, 45, 0.16);
          border-radius: 4px;
          font: 500 12px/1.2 inherit;
          color: #242631;
          background: #ffffff;
          outline: none;
          transition: border-color 0.15s, box-shadow 0.15s;
        }
        .popover-input:focus {
          border-color: #ff5a8a;
          box-shadow: 0 0 0 2px rgba(255, 90, 138, 0.18);
        }
        .popover-input:disabled {
          background: #f4f5f8;
          color: #999;
        }
        .popover-button {
          flex: 0 0 auto;
          background: #ff5a8a;
          color: #ffffff;
          border: 1px solid transparent;
          border-radius: 4px;
          padding: 6px 12px;
          font: 600 12px/1.2 inherit;
          cursor: pointer;
          transition: background 0.15s, opacity 0.15s;
        }
        .popover-button:hover:not(:disabled) {
          background: #ff4b81;
        }
        .popover-button:focus-visible {
          outline: 2px solid rgba(255, 90, 138, 0.5);
          outline-offset: 1px;
        }
        .popover-button:disabled {
          opacity: 0.6;
          cursor: default;
        }
        .popover-quick-create-button {
          width: 100%;
          padding: 7px 12px;
          margin-bottom: 2px;
        }
        .popover-shared-video-row {
          flex-direction: column;
          align-items: stretch;
          gap: 3px;
        }
        .popover-shared-video-value {
          flex: none;
          white-space: normal;
          word-break: break-word;
          overflow: visible;
          text-overflow: clip;
          line-height: 1.4;
          font-weight: 500;
        }
        .popover-shared-video-value.is-empty {
          color: #999;
          font-style: italic;
          font-weight: 400;
        }
        .popover-nickname-row {
          flex-wrap: wrap;
        }
        .popover-nickname-input {
          flex: 1 1 100px;
          min-width: 0;
        }
        .popover-inline-actions {
          display: flex;
          gap: 6px;
          flex: 0 0 auto;
        }
        .popover-inline-actions .popover-button {
          padding: 4px 10px;
        }
        .popover-button.is-ghost {
          background: transparent;
          color: #5b6070;
          border-color: rgba(27, 31, 45, 0.16);
        }
        .popover-button.is-ghost:hover:not(:disabled) {
          background: rgba(27, 31, 45, 0.05);
          color: #242631;
        }
        .popover-button.is-danger {
          background: transparent;
          color: #d44c4c;
          border-color: rgba(212, 76, 76, 0.3);
        }
        .popover-button.is-danger:hover:not(:disabled) {
          background: rgba(212, 76, 76, 0.08);
        }
        .popover-members {
          list-style: none;
          margin: 0;
          padding: 0;
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
        }
        .popover-member-chip {
          background: rgba(255, 90, 138, 0.1);
          color: #c43d6e;
          padding: 3px 8px;
          border-radius: 999px;
          font-size: 11px;
          line-height: 14px;
          font-weight: 500;
        }
        .popover-member-chip.is-self {
          background: rgba(0, 161, 214, 0.14);
          color: #0078a0;
        }
        .popover-error {
          color: #d44c4c;
          font-size: 11px;
          line-height: 16px;
          margin: 0;
        }
        .quick-toggle {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          margin-top: 10px;
          padding-top: 9px;
          border-top: 1px solid rgba(27, 31, 45, 0.08);
          color: #4a4f5d;
          cursor: pointer;
          font-size: 12px;
          line-height: 18px;
        }
        .quick-toggle-switch {
          position: relative;
          display: inline-flex;
          flex: 0 0 auto;
          width: 32px;
          height: 18px;
          align-items: center;
        }
        .quick-toggle-input {
          position: absolute;
          inset: 0;
          margin: 0;
          cursor: pointer;
          opacity: 0;
        }
        .quick-toggle-track {
          position: absolute;
          inset: 0;
          border-radius: 999px;
          background: #d6dae3;
          transition: background 0.16s ease;
        }
        .quick-toggle-thumb {
          position: absolute;
          top: 2px;
          left: 2px;
          width: 14px;
          height: 14px;
          border-radius: 999px;
          background: #ffffff;
          box-shadow: 0 1px 3px rgba(27, 31, 45, 0.18);
          transition: transform 0.16s ease;
        }
        .quick-toggle-input:checked + .quick-toggle-track {
          background: #ff5a8a;
        }
        .quick-toggle-input:checked + .quick-toggle-track .quick-toggle-thumb {
          transform: translateX(14px);
        }
        .quick-toggle-input:focus-visible + .quick-toggle-track {
          outline: 2px solid rgba(255, 90, 138, 0.26);
          outline-offset: 2px;
        }
        .quick-toggle-input:disabled {
          cursor: wait;
        }
        .quick-toggle-input:disabled + .quick-toggle-track {
          opacity: 0.72;
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
          .share-popover {
            border-color: rgba(255, 107, 150, 0.22);
            background: rgba(31, 34, 43, 0.98);
            color: #f4f5f8;
            box-shadow: 0 10px 24px rgba(0, 0, 0, 0.28), 0 2px 8px rgba(0, 0, 0, 0.2);
          }
          .popover-status,
          .quick-toggle {
            color: #b8becd;
          }
          .popover-section + .popover-section {
            border-top-color: rgba(255, 255, 255, 0.1);
          }
          .popover-row-label {
            color: #9499a0;
          }
          .popover-row-value {
            color: #f4f5f8;
          }
          .popover-link-button {
            background: transparent;
            border-color: rgba(255, 255, 255, 0.16);
            color: #ff85a9;
          }
          .popover-link-button:hover:not(:disabled) {
            background: rgba(255, 107, 150, 0.12);
            border-color: rgba(255, 107, 150, 0.4);
          }
          .popover-link-button.is-copied {
            background: rgba(102, 187, 51, 0.12);
            border-color: rgba(102, 187, 51, 0.4);
            color: #80d965;
          }
          .popover-input {
            background: rgba(255, 255, 255, 0.04);
            border-color: rgba(255, 255, 255, 0.16);
            color: #f4f5f8;
          }
          .popover-input:focus {
            border-color: #ff85a9;
            box-shadow: 0 0 0 2px rgba(255, 107, 150, 0.18);
          }
          .popover-input:disabled {
            background: rgba(255, 255, 255, 0.02);
            color: #666;
          }
          .popover-button {
            background: #ff6b96;
          }
          .popover-button:hover:not(:disabled) {
            background: #ff85a9;
          }
          .popover-button.is-ghost {
            background: transparent;
            color: #b8becd;
            border-color: rgba(255, 255, 255, 0.16);
          }
          .popover-button.is-ghost:hover:not(:disabled) {
            background: rgba(255, 255, 255, 0.05);
            color: #f4f5f8;
          }
          .popover-button.is-danger {
            color: #f08080;
            border-color: rgba(240, 128, 128, 0.3);
          }
          .popover-button.is-danger:hover:not(:disabled) {
            background: rgba(240, 128, 128, 0.08);
          }
          .popover-member-chip {
            background: rgba(255, 107, 150, 0.16);
            color: #ffadc4;
          }
          .popover-member-chip.is-self {
            background: rgba(0, 161, 214, 0.16);
            color: #6ec3d8;
          }
          .popover-error {
            color: #f08080;
          }
          .quick-toggle {
            border-top-color: rgba(255, 255, 255, 0.1);
          }
          .quick-toggle-track {
            background: #5b6070;
          }
        }
      </style>
      <button class="share-button" type="button">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path fill="currentColor" d="M21 0H3a3 3 0 0 0-3 3v9a3 3 0 0 0 3 3h18a3 3 0 0 0 3-3V3a3 3 0 0 0-3-3m1 12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h18a1 1 0 0 1 1 1Z"></path>
          <path fill="currentColor" d="M9.54 3.79a.37.37 0 0 0-.41 0a.6.6 0 0 0-.19.45v6.42a.6.6 0 0 0 .19.45a.37.37 0 0 0 .41.05l5.58-2.94a.88.88 0 0 0 0-1.53ZM4.5 18a3 3 0 0 0-3 3v2.5a.5.5 0 0 0 .5.5h5a.5.5 0 0 0 .5-.5V21a3 3 0 0 0-3-3m7.5 0a3 3 0 0 0-3 3v2.5a.5.5 0 0 0 .5.5h5a.5.5 0 0 0 .5-.5V21a3 3 0 0 0-3-3m7.5 0a3 3 0 0 0-3 3v2.5a.5.5 0 0 0 .5.5h5a.5.5 0 0 0 .5-.5V21a3 3 0 0 0-3-3"></path>
        </svg>
      </button>
      <div class="share-popover" hidden role="dialog" aria-label="${t("pageSharePopoverTitle")}">
        <div class="popover-heading">${t("pageSharePopoverTitle")}</div>
        <p class="popover-status" hidden></p>
        <div class="popover-section popover-section-join" hidden>
          <button class="popover-button popover-quick-create-button" type="button">${t("pageShareQuickCreate")}</button>
          <form class="popover-form popover-join-form">
            <div class="popover-input-row">
              <input class="popover-input popover-join-input" type="text" inputmode="numeric" maxlength="4" autocomplete="off" placeholder="${t("pageShareJoinPlaceholder")}" aria-label="${t("pageShareJoinPlaceholder")}">
              <button class="popover-button popover-join-button" type="submit">${t("pageShareJoin")}</button>
            </div>
            <p class="popover-error popover-join-error" hidden></p>
          </form>
        </div>
        <div class="popover-section popover-section-joined" hidden>
          <div class="popover-row popover-room-code-row">
            <span class="popover-row-label">${t("pageShareRoomCode")}</span>
            <span class="popover-row-value popover-room-code-value" title=""></span>
            <button class="popover-link-button popover-copy-button" type="button">${t("pageShareRoomCodeCopy")}</button>
          </div>
          <div class="popover-row popover-shared-video-row">
            <span class="popover-row-label">${t("pageShareSharedVideo")}</span>
            <span class="popover-row-value popover-shared-video-value" title=""></span>
          </div>
          <div class="popover-row popover-nickname-row">
            <span class="popover-row-label">${t("pageShareNickname")}</span>
            <span class="popover-row-value popover-nickname-value" title=""></span>
            <input class="popover-input popover-nickname-input" type="text" maxlength="32" autocomplete="off" aria-label="${t("pageShareNickname")}" hidden>
            <button class="popover-link-button popover-edit-nickname-button" type="button">${t("pageShareNicknameEdit")}</button>
          </div>
          <p class="popover-error popover-nickname-error" hidden></p>
          <div class="popover-row popover-members-row">
            <span class="popover-row-label">${t("pageShareMembersHeading", { count: 0 })}</span>
            <ul class="popover-members"></ul>
          </div>
          <button class="popover-button is-danger popover-leave-button" type="button">${t("pageShareLeaveRoom")}</button>
        </div>
        <label class="quick-toggle">
          <span>${t("pageShareButtonQuickDisable")}</span>
          <span class="quick-toggle-switch">
            <input class="quick-toggle-input" type="checkbox" checked aria-label="${t("pageShareButtonQuickDisable")}">
            <span class="quick-toggle-track" aria-hidden="true">
              <span class="quick-toggle-thumb"></span>
            </span>
          </span>
        </label>
      </div>
    `,
    );
    button = shadowRoot.querySelector("button");
    popover = shadowRoot.querySelector(".share-popover");
    popoverStatus = shadowRoot.querySelector(".popover-status");
    popoverToggle = shadowRoot.querySelector(".quick-toggle-input");
    joinSection = shadowRoot.querySelector(".popover-section-join");
    joinForm = shadowRoot.querySelector(".popover-join-form");
    joinInput = shadowRoot.querySelector(".popover-join-input");
    _joinButton = shadowRoot.querySelector(".popover-join-button");
    joinError = shadowRoot.querySelector(".popover-join-error");
    quickCreateButton = shadowRoot.querySelector(
      ".popover-quick-create-button",
    );
    joinedSection = shadowRoot.querySelector(".popover-section-joined");
    roomCodeValueEl = shadowRoot.querySelector(".popover-room-code-value");
    copyButton = shadowRoot.querySelector(".popover-copy-button");
    sharedVideoValueEl = shadowRoot.querySelector(
      ".popover-shared-video-value",
    );
    nicknameValueEl = shadowRoot.querySelector(".popover-nickname-value");
    editNicknameButton = shadowRoot.querySelector(
      ".popover-edit-nickname-button",
    );
    nicknameInput = shadowRoot.querySelector(".popover-nickname-input");
    nicknameError = shadowRoot.querySelector(".popover-nickname-error");
    membersHeadingEl = shadowRoot.querySelector(
      ".popover-members-row .popover-row-label",
    );
    membersList = shadowRoot.querySelector(".popover-members");
    leaveButton = shadowRoot.querySelector(".popover-leave-button");
    button?.addEventListener("pointerdown", handlePointerDown);
    button?.addEventListener("pointermove", handlePointerMove);
    button?.addEventListener("pointerup", handlePointerUp);
    button?.addEventListener("pointercancel", handlePointerCancel);
    button?.addEventListener("pointerenter", () => showPopover());
    button?.addEventListener("pointerleave", hidePopoverSoon);
    button?.addEventListener("focus", () => showPopover());
    popover?.addEventListener("pointerenter", () =>
      showPopover({ refresh: false }),
    );
    popover?.addEventListener("pointerleave", hidePopoverSoon);
    popoverToggle?.addEventListener("change", (event) => {
      void handleQuickToggleChange(event);
    });
    shadowRoot.addEventListener("focusout", (event) => {
      const relatedTarget = (event as FocusEvent).relatedTarget;
      if (relatedTarget instanceof Node && shadowRoot.contains(relatedTarget)) {
        return;
      }
      hidePopoverSoon();
    });
    button?.addEventListener("click", (event) => {
      if (suppressNextClick) {
        suppressNextClick = false;
        event.preventDefault();
        return;
      }
      void handleClick();
    });
    joinForm?.addEventListener("submit", (event) => {
      event.preventDefault();
      void handleJoinSubmit();
    });
    joinInput?.addEventListener("focus", () => {
      nicknameInputFocused = false;
    });
    quickCreateButton?.addEventListener("click", () => {
      void handleQuickCreate();
    });
    copyButton?.addEventListener("click", () => {
      void handleCopyRoomCode();
    });
    editNicknameButton?.addEventListener("click", () => {
      if (nicknameEditing) {
        cancelNicknameEditing();
      } else {
        startNicknameEditing();
      }
    });
    nicknameInput?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void handleSaveNickname();
      } else if (event.key === "Escape") {
        cancelNicknameEditing();
      }
    });
    nicknameInput?.addEventListener("focus", () => {
      nicknameInputFocused = true;
    });
    nicknameInput?.addEventListener("blur", () => {
      nicknameInputFocused = false;
    });
    leaveButton?.addEventListener("click", () => {
      void handleLeaveRoom();
    });
    mountTarget.appendChild(host);
    render();
  }

  function startNicknameEditing(): void {
    nicknameEditing = true;
    nicknameErrorMessage = null;
    render();
    if (nicknameInput) {
      nicknameInput.focus();
      nicknameInput.select();
    }
  }

  function cancelNicknameEditing(): void {
    nicknameEditing = false;
    nicknameErrorMessage = null;
    render();
  }

  async function handleCopyRoomCode(): Promise<void> {
    const code = popoverContext?.roomCode;
    if (!code) {
      return;
    }
    const value = code;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const fallback = document.createElement("textarea");
        fallback.value = value;
        fallback.style.position = "fixed";
        fallback.style.opacity = "0";
        document.body.appendChild(fallback);
        fallback.focus();
        fallback.select();
        document.execCommand("copy");
        fallback.remove();
      }
      setCopyButtonCopied();
    } catch (error) {
      args.toastPresenter.show(
        t("pageSharePopoverError", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  function setCopyButtonCopied(): void {
    if (copyButtonResetTimer) {
      window.clearTimeout(copyButtonResetTimer);
      copyButtonResetTimer = 0;
    }
    copyButtonState = "copied";
    render();
    copyButtonResetTimer = window.setTimeout(() => {
      copyButtonResetTimer = 0;
      copyButtonState = "idle";
      render();
    }, 1400);
  }

  async function handleJoinSubmit(): Promise<void> {
    if (joinPending) {
      return;
    }
    const rawValue = joinInput?.value ?? "";
    const trimmed = rawValue.trim();
    if (!/^\d{4}$/.test(trimmed)) {
      joinErrorMessage = t("errorInvalidInviteFormat");
      render();
      return;
    }
    joinErrorMessage = null;
    joinPending = true;
    render();
    try {
      await args.runtimeSendMessage({
        type: "content:join-room",
        roomCode: trimmed,
        joinToken: null,
      });
      // Refresh the popover once the server replies (or after a small grace
      // period) so the joined section takes over.
      window.setTimeout(() => {
        joinPending = false;
        void refreshPopoverContext();
      }, 800);
    } catch (error) {
      joinPending = false;
      joinErrorMessage = t("pageShareJoinFailed", {
        error: error instanceof Error ? error.message : String(error),
      });
      render();
    }
  }

  async function handleQuickCreate(): Promise<void> {
    if (quickCreatePending) {
      return;
    }
    quickCreatePending = true;
    render();
    try {
      await args.runtimeSendMessage({ type: "content:create-room" });
      // The background resolves the create-room flow once room:created lands.
      // Wait briefly then auto-share the current video into the fresh room and
      // refresh the popover so the joined section appears.
      window.setTimeout(() => {
        void autoShareCurrentVideoAfterCreate().finally(() => {
          quickCreatePending = false;
          void refreshPopoverContext();
        });
      }, QUICK_CREATE_SETTLE_DELAY_MS);
    } catch (error) {
      quickCreatePending = false;
      args.toastPresenter.show(
        t("pageShareQuickCreateFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      render();
    }
  }

  async function autoShareCurrentVideoAfterCreate(): Promise<void> {
    // After a quick-create, if the current tab is a Bilibili video page, share
    // it into the freshly created room automatically. The room is guaranteed to
    // exist here (we just created it), so no confirm is needed. If there is no
    // playable video, silently do nothing — never block create success.
    try {
      const payload = await args.resolveCurrentSharePayload();
      if (!payload) {
        return;
      }
      await args.runtimeSendMessage({ type: "content:share-current-video" });
    } catch {
      // Auto-share is best-effort; swallow errors so create still succeeds.
    }
  }

  async function handleSaveNickname(): Promise<void> {
    if (!nicknameInput) {
      return;
    }
    const next = nicknameInput.value.trim();
    if (!next) {
      nicknameErrorMessage = t("pageSharePopoverError", {
        error: t("pageShareNickname"),
      });
      render();
      return;
    }
    nicknameErrorMessage = null;
    try {
      await args.runtimeSendMessage({
        type: "content:set-display-name",
        displayName: next,
      });
      nicknameEditing = false;
      args.toastPresenter.show(t("pageShareNicknameSaved"));
      void refreshPopoverContext();
    } catch (error) {
      nicknameErrorMessage = t("pageSharePopoverError", {
        error: error instanceof Error ? error.message : String(error),
      });
      render();
    }
  }

  async function handleLeaveRoom(): Promise<void> {
    if (leavePending) {
      return;
    }
    leavePending = true;
    render();
    try {
      await args.runtimeSendMessage({ type: "content:leave-room" });
      nicknameEditing = false;
      nicknameErrorMessage = null;
      void refreshPopoverContext();
    } finally {
      leavePending = false;
      render();
    }
  }

  function handlePointerDown(event: PointerEvent): void {
    if (!button || pending || event.button !== 0) {
      return;
    }
    hidePopover();
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
