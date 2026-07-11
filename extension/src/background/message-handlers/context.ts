import type {
  PlaybackState,
  RoomState,
  SharedVideo,
} from "@bili-syncplay/protocol";

export type QueueSharedVideoResult =
  { ok: true } | { ok: false; error: string };

/**
 * Shared dependency bag threaded through every runtime-message handler. It is
 * the exact set of collaborators the background message controller is
 * constructed with, so handlers stay pure functions of `(context, message,
 * sender, sendResponse)` with no hidden module state.
 */
export interface MessageHandlerContext {
  connectionState: {
    connected: boolean;
    lastError: string | null;
    socket: WebSocket | null;
  };
  roomSessionState: {
    roomCode: string | null;
    memberToken: string | null;
    memberId: string | null;
    displayName: string | null;
    joinToken: string | null;
    roomState: RoomState | null;
    awaitingFreshRoomState: boolean;
  };
  settingsState: {
    pageShareButtonEnabled: boolean;
  };
  diagnosticsController: {
    log: (scope: "popup" | "content", message: string) => void;
    maybeLogPopupStateRequest: () => void;
    formatContentSource: (sender: chrome.runtime.MessageSender) => string;
  };
  popupStateController: {
    popupState: () => unknown;
  };
  roomSessionController: {
    requestCreateRoom(): Promise<void>;
    requestJoinRoom(roomCode: string, joinToken: string | null): Promise<void>;
    waitForJoinAttemptResult(timeoutMs?: number): Promise<unknown>;
    requestLeaveRoom(): Promise<void>;
  };
  shareController: {
    getActiveVideoPayload(): Promise<{
      ok: boolean;
      payload: { video: SharedVideo; playback: PlaybackState | null } | null;
      tabId: number | null;
      error?: string;
    }>;
    getVideoPayloadFromTab(
      tab: Pick<chrome.tabs.Tab, "id" | "url"> | null | undefined,
    ): Promise<{
      ok: boolean;
      payload: { video: SharedVideo; playback: PlaybackState | null } | null;
      tabId: number | null;
      error?: string;
    }>;
    queueOrSendSharedVideo(
      payload: { video: SharedVideo; playback: PlaybackState | null },
      tabId: number | null,
      isAutoShare?: boolean,
    ): Promise<QueueSharedVideoResult>;
    stagePendingShareFromTab(
      tab: Pick<chrome.tabs.Tab, "id" | "url"> | null | undefined,
    ): Promise<boolean>;
    hasActivePendingLocalShare(): boolean;
    hasActivePendingManualShare(): boolean;
    getActivePendingLocalShareUrl(): string | null;
  };
  tabController: {
    openSharedVideoFromPopup(): Promise<void>;
    isActiveSharedTab(tabId?: number, videoUrl?: string | null): boolean;
    isRememberedSharedSourceTab(tabId?: number): boolean;
    canReclaimSharedSourceTab(tabId?: number): boolean;
    reclaimSharedSourceTabIfUnclaimed(tabId?: number): boolean;
  };
  clockController: {
    compensateRoomState(state: RoomState): RoomState;
  };
  socketController: {
    connect(): Promise<void>;
  };
  sendToServer: (message: unknown) => void;
  updateServerUrl: (serverUrl: string) => Promise<void>;
  persistState: () => Promise<void>;
  persistProfileState: () => Promise<void>;
  notifyPageShareButtonSettings: () => Promise<void>;
  notifyAll: () => void;
}

/**
 * Update the page-share-button toggle and fan the change out to every surface.
 * Shared by the popup and content settings handlers so they stay identical.
 */
export async function updatePageShareButtonEnabled(
  context: MessageHandlerContext,
  enabled: boolean,
): Promise<void> {
  context.settingsState.pageShareButtonEnabled = enabled;
  await context.persistProfileState();
  context.notifyAll();
  await context.notifyPageShareButtonSettings();
}

/**
 * Push a display-name change to the server when we are in a room. Both the
 * popup and content set-display-name paths reuse this so the profile:update
 * dispatch rule lives in exactly one place.
 */
export function pushDisplayNameUpdate(context: MessageHandlerContext): void {
  if (
    context.connectionState.connected &&
    context.roomSessionState.roomCode &&
    context.roomSessionState.memberToken
  ) {
    context.sendToServer({
      type: "profile:update",
      payload: {
        memberToken: context.roomSessionState.memberToken,
        displayName: context.roomSessionState.displayName,
      },
    });
  }
}
