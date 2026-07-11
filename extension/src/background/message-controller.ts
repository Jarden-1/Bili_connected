import type {
  ContentToBackgroundMessage,
  PopupToBackgroundMessage,
} from "../shared/messages";
import type { MessageHandlerContext } from "./message-handlers/context";
import {
  handleContentCreateRoom,
  handleContentGetRoomState,
  handleContentJoinRoom,
  handleContentLeaveRoom,
  handlePopupCreateRoom,
  handlePopupGetState,
  handlePopupJoinRoom,
  handlePopupLeaveRoom,
} from "./message-handlers/room-handlers";
import {
  handleAutoShareNextVideo,
  handleContentShareCurrentVideo,
  handleGetShareContext,
  handleOpenSharedVideo,
  handlePopupGetActiveVideo,
  handlePopupShareCurrentVideo,
} from "./message-handlers/share-handlers";
import {
  handleContentDebugLog,
  handleContentReportUser,
  handleContentSetDisplayName,
  handleContentSetPageShareButtonEnabled,
  handleGetPageShareButtonSettings,
  handlePopupDebugLog,
  handlePopupSetDisplayName,
  handlePopupSetPageShareButtonEnabled,
  handleSetServerUrl,
} from "./message-handlers/settings-handlers";
import {
  handlePlaybackUpdate,
  handleRoomChat,
} from "./message-handlers/playback-handlers";

type RuntimeMessage = PopupToBackgroundMessage | ContentToBackgroundMessage;

export interface MessageController {
  handleRuntimeMessage(
    message: RuntimeMessage,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ): Promise<void>;
}

/**
 * Runtime-message router. The controller owns no logic beyond dispatch: every
 * `case` forwards to a domain handler in `./message-handlers/*`, all of which
 * receive the same `MessageHandlerContext` (the dependency bag passed here).
 * Keeping this file a thin switch is a project structural constraint — add new
 * behavior in a handler module, not inline here.
 */
export function createMessageController(
  context: MessageHandlerContext,
): MessageController {
  async function handleRuntimeMessage(
    message: RuntimeMessage,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ): Promise<void> {
    switch (message.type) {
      case "popup:create-room":
        return handlePopupCreateRoom(context, sendResponse);
      case "popup:join-room":
        return handlePopupJoinRoom(context, message, sendResponse);
      case "popup:leave-room":
        return handlePopupLeaveRoom(context, sendResponse);
      case "popup:debug-log":
        return handlePopupDebugLog(context, message, sendResponse);
      case "popup:get-state":
        return handlePopupGetState(context, sendResponse);
      case "popup:get-active-video":
        return handlePopupGetActiveVideo(context, sendResponse);
      case "popup:share-current-video":
        return handlePopupShareCurrentVideo(context, sendResponse);
      case "popup:open-shared-video":
        return handleOpenSharedVideo(context, sendResponse);
      case "popup:set-server-url":
        return handleSetServerUrl(context, message, sendResponse);
      case "popup:set-page-share-button-enabled":
        return handlePopupSetPageShareButtonEnabled(
          context,
          message,
          sendResponse,
        );
      case "popup:set-display-name":
        return handlePopupSetDisplayName(context, message, sendResponse);
      case "content:get-share-context":
        return handleGetShareContext(context, sendResponse);
      case "content:share-current-video":
        return handleContentShareCurrentVideo(context, sender, sendResponse);
      case "content:auto-share-next-video":
        return handleAutoShareNextVideo(context, message, sender, sendResponse);
      case "content:get-page-share-button-settings":
        return handleGetPageShareButtonSettings(context, sendResponse);
      case "content:set-page-share-button-enabled":
        return handleContentSetPageShareButtonEnabled(
          context,
          message,
          sendResponse,
        );
      case "content:report-user":
        return handleContentReportUser(context, message, sendResponse);
      case "content:playback-update":
        return handlePlaybackUpdate(context, message, sender, sendResponse);
      case "content:get-room-state":
        return handleContentGetRoomState(context, sendResponse);
      case "content:create-room":
        return handleContentCreateRoom(context, sender, sendResponse);
      case "content:join-room":
        return handleContentJoinRoom(context, message, sendResponse);
      case "content:leave-room":
        return handleContentLeaveRoom(context, sendResponse);
      case "content:set-display-name":
        return handleContentSetDisplayName(context, message, sendResponse);
      case "content:room-chat":
        return handleRoomChat(context, message, sendResponse);
      case "content:debug-log":
        return handleContentDebugLog(context, message, sender, sendResponse);
      default:
        sendResponse({ ok: false });
    }
  }

  return {
    handleRuntimeMessage,
  };
}
