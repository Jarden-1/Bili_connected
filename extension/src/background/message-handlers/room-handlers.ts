import type { MessageHandlerContext } from "./context";

type Respond = (response?: unknown) => void;

/**
 * popup:create-room — stage the active tab's video (if any) BEFORE issuing the
 * create so the room:created flush auto-shares it, then wait briefly for the
 * async room:created to populate joinToken before replying with fresh state.
 */
export async function handlePopupCreateRoom(
  context: MessageHandlerContext,
  sendResponse: Respond,
): Promise<void> {
  // Stage the active tab's video (if any) BEFORE issuing the create, so
  // the room:created flush auto-shares it. Best-effort: a non-video tab
  // simply stages nothing and room creation still succeeds.
  await context.shareController.stagePendingShareFromTab(null);
  await context.roomSessionController.requestCreateRoom();
  // Wait for the asynchronous room:created response to populate
  // roomSessionState.joinToken (up to 5s) so the popup gets the fresh
  // invite code on the first round-trip instead of a stale null.
  const createDeadline = Date.now() + 5000;
  while (!context.roomSessionState.joinToken && Date.now() < createDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  sendResponse(context.popupStateController.popupState());
}

/**
 * content:create-room — the content script lives on the Bilibili tab, so stage
 * the requesting page's video BEFORE creating for the same room:created flush.
 */
export async function handleContentCreateRoom(
  context: MessageHandlerContext,
  sender: chrome.runtime.MessageSender,
  sendResponse: Respond,
): Promise<void> {
  // Stage the requesting page's video (the content script lives on the
  // Bilibili tab) BEFORE creating, so the room:created flush auto-shares
  // it. Best-effort: staging nothing never blocks room creation.
  await context.shareController.stagePendingShareFromTab(sender.tab);
  await context.roomSessionController.requestCreateRoom();
  sendResponse({ ok: true });
}

export async function handlePopupJoinRoom(
  context: MessageHandlerContext,
  message: { roomCode: string; joinToken: string | null },
  sendResponse: Respond,
): Promise<void> {
  await context.roomSessionController.requestJoinRoom(
    message.roomCode,
    message.joinToken,
  );
  if (!context.connectionState.connected) {
    sendResponse(context.popupStateController.popupState());
    return;
  }
  await context.roomSessionController.waitForJoinAttemptResult();
  sendResponse(context.popupStateController.popupState());
}

export async function handleContentJoinRoom(
  context: MessageHandlerContext,
  message: { roomCode: string; joinToken: string | null },
  sendResponse: Respond,
): Promise<void> {
  await context.roomSessionController.requestJoinRoom(
    message.roomCode,
    message.joinToken,
  );
  if (!context.connectionState.connected) {
    sendResponse({ ok: false, error: "not-connected" });
    return;
  }
  await context.roomSessionController.waitForJoinAttemptResult();
  sendResponse({ ok: true });
}

export async function handlePopupLeaveRoom(
  context: MessageHandlerContext,
  sendResponse: Respond,
): Promise<void> {
  await context.roomSessionController.requestLeaveRoom();
  sendResponse(context.popupStateController.popupState());
}

export async function handleContentLeaveRoom(
  context: MessageHandlerContext,
  sendResponse: Respond,
): Promise<void> {
  await context.roomSessionController.requestLeaveRoom();
  sendResponse({ ok: true });
}

export function handlePopupGetState(
  context: MessageHandlerContext,
  sendResponse: Respond,
): void {
  context.diagnosticsController.maybeLogPopupStateRequest();
  if (context.roomSessionState.roomCode && !context.connectionState.connected) {
    void context.socketController.connect();
  }
  sendResponse(context.popupStateController.popupState());
}

export function handleContentGetRoomState(
  context: MessageHandlerContext,
  sendResponse: Respond,
): void {
  if (context.roomSessionState.roomCode && !context.connectionState.connected) {
    void context.socketController.connect();
  }
  if (
    context.connectionState.connected &&
    context.roomSessionState.roomCode &&
    context.roomSessionState.memberToken
  ) {
    context.sendToServer({
      type: "sync:request",
      payload: { memberToken: context.roomSessionState.memberToken },
    });
  }
  sendResponse(
    context.roomSessionState.roomState
      ? {
          ok: true,
          roomState: context.clockController.compensateRoomState(
            context.roomSessionState.roomState,
          ),
          memberId: context.roomSessionState.memberId,
          roomCode: context.roomSessionState.roomCode,
          displayName: context.roomSessionState.displayName,
          joinToken: context.roomSessionState.joinToken,
        }
      : {
          ok: false,
          memberId: context.roomSessionState.memberId,
          roomCode: context.roomSessionState.roomCode,
          displayName: context.roomSessionState.displayName,
          joinToken: context.roomSessionState.joinToken,
        },
  );
}
