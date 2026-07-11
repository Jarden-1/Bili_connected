import {
  pushDisplayNameUpdate,
  updatePageShareButtonEnabled,
} from "./context";
import type { MessageHandlerContext } from "./context";
import type { PageShareButtonSettingsResponse } from "../../shared/messages";

type Respond = (response?: unknown) => void;

export function handlePopupDebugLog(
  context: MessageHandlerContext,
  message: { message: string },
  sendResponse: Respond,
): void {
  context.diagnosticsController.log("popup", message.message);
  sendResponse({ ok: true });
}

export function handleContentDebugLog(
  context: MessageHandlerContext,
  message: { payload: { message: string } },
  sender: chrome.runtime.MessageSender,
  sendResponse: Respond,
): void {
  context.diagnosticsController.log(
    "content",
    `[${context.diagnosticsController.formatContentSource(sender)}] ${message.payload.message}`,
  );
  sendResponse({ ok: true });
}

export async function handleSetServerUrl(
  context: MessageHandlerContext,
  message: { serverUrl: string },
  sendResponse: Respond,
): Promise<void> {
  await context.updateServerUrl(message.serverUrl);
  sendResponse(context.popupStateController.popupState());
}

export async function handlePopupSetPageShareButtonEnabled(
  context: MessageHandlerContext,
  message: { enabled: boolean },
  sendResponse: Respond,
): Promise<void> {
  await updatePageShareButtonEnabled(context, message.enabled);
  sendResponse(context.popupStateController.popupState());
}

export function handleGetPageShareButtonSettings(
  context: MessageHandlerContext,
  sendResponse: Respond,
): void {
  sendResponse({
    ok: true,
    enabled: context.settingsState.pageShareButtonEnabled,
  } satisfies PageShareButtonSettingsResponse);
}

export async function handleContentSetPageShareButtonEnabled(
  context: MessageHandlerContext,
  message: { enabled: boolean },
  sendResponse: Respond,
): Promise<void> {
  await updatePageShareButtonEnabled(context, message.enabled);
  sendResponse({
    ok: true,
    enabled: context.settingsState.pageShareButtonEnabled,
  } satisfies PageShareButtonSettingsResponse);
}

export async function handlePopupSetDisplayName(
  context: MessageHandlerContext,
  message: { displayName: string },
  sendResponse: Respond,
): Promise<void> {
  const trimmedName = message.displayName.trim();
  if (!trimmedName) {
    sendResponse(context.popupStateController.popupState());
    return;
  }
  context.roomSessionState.displayName = trimmedName;
  await context.persistProfileState();
  pushDisplayNameUpdate(context);
  context.notifyAll();
  sendResponse(context.popupStateController.popupState());
}

export async function handleContentSetDisplayName(
  context: MessageHandlerContext,
  message: { displayName: string },
  sendResponse: Respond,
): Promise<void> {
  context.roomSessionState.displayName =
    message.displayName.trim() || context.roomSessionState.displayName;
  await context.persistProfileState();
  pushDisplayNameUpdate(context);
  sendResponse({
    ok: true,
    displayName: context.roomSessionState.displayName,
  });
}

export async function handleContentReportUser(
  context: MessageHandlerContext,
  message: { payload: { displayName: string } },
  sendResponse: Respond,
): Promise<void> {
  // Auto-report from Bilibili login only seeds the initial display name.
  // Once set, subsequent auto-reports are ignored so user-edited nicknames
  // (via content:set-display-name) survive page reloads.
  if (
    context.roomSessionState.displayName === null &&
    message.payload.displayName
  ) {
    context.roomSessionState.displayName = message.payload.displayName;
    await context.persistProfileState();
    pushDisplayNameUpdate(context);
  }
  sendResponse({ ok: true });
}
