import type { RoomCode } from "./common.js";
import type { PlaybackState, SharedVideo } from "./domain.js";

export interface ClientHelloPayload {
  displayName?: string;
  protocolVersion?: number;
}

export interface CreateRoomMessage {
  type: "room:create";
  payload?: ClientHelloPayload;
}

export interface JoinRoomMessage {
  type: "room:join";
  payload: {
    roomCode: RoomCode;
    /**
     * Optional invite token. 4-digit public rooms accept joins without a
     * token; private rooms must still echo the token returned by `room:created`.
     */
    joinToken?: string;
    memberToken?: string;
    displayName?: string;
    protocolVersion?: number;
  };
}

export interface ProfileUpdateMessage {
  type: "profile:update";
  payload: {
    memberToken: string;
    displayName: string;
  };
}

export interface LeaveRoomMessage {
  type: "room:leave";
  payload?: {
    memberToken?: string;
  };
}

export interface ShareVideoMessage {
  type: "video:share";
  payload: {
    memberToken: string;
    video: SharedVideo;
    playback?: PlaybackState;
  };
}

export interface PlaybackUpdateMessage {
  type: "playback:update";
  payload: {
    memberToken: string;
    playback: PlaybackState;
  };
}

export interface SyncRequestMessage {
  type: "sync:request";
  payload: {
    memberToken: string;
  };
}

export interface SyncPingMessage {
  type: "sync:ping";
  payload: {
    clientSendTime: number;
  };
}

export interface RoomChatMessage {
  type: "room:chat";
  payload: {
    memberToken: string;
    text: string;
  };
}

export type ClientMessage =
  | CreateRoomMessage
  | JoinRoomMessage
  | ProfileUpdateMessage
  | LeaveRoomMessage
  | ShareVideoMessage
  | PlaybackUpdateMessage
  | SyncRequestMessage
  | SyncPingMessage
  | RoomChatMessage;
