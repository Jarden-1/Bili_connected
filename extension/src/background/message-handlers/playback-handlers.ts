import type { MessageHandlerContext } from "./context";
import type { PlaybackState } from "@bili-syncplay/protocol";

type Respond = (response?: unknown) => void;

export function handlePlaybackUpdate(
  context: MessageHandlerContext,
  message: { payload: PlaybackState & { url: string; actorId: string } },
  sender: chrome.runtime.MessageSender,
  sendResponse: Respond,
): void {
  if (
    context.connectionState.connected &&
    context.roomSessionState.memberToken &&
    context.tabController.isActiveSharedTab(sender.tab?.id, message.payload.url)
  ) {
    context.sendToServer({
      type: "playback:update",
      payload: {
        memberToken: context.roomSessionState.memberToken,
        playback: {
          ...message.payload,
          serverTime: 0,
          actorId:
            context.roomSessionState.memberId ?? message.payload.actorId,
        },
      },
    });
  }
  sendResponse({ ok: true });
}

export function handleRoomChat(
  context: MessageHandlerContext,
  message: { text: string },
  sendResponse: Respond,
): void {
  if (
    context.connectionState.connected &&
    context.roomSessionState.roomCode &&
    context.roomSessionState.memberToken
  ) {
    context.sendToServer({
      type: "room:chat",
      payload: {
        memberToken: context.roomSessionState.memberToken,
        text: message.text,
      },
    });
  }
  sendResponse({ ok: true });
}
