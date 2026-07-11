import {
  isExplicitControlSyncIntent,
  type PlaybackState,
} from "@bili-syncplay/protocol";
import type { PlaybackAuthority } from "./types.js";

// How long an actor keeps the "authority window" after issuing a control
// action (play/pause/seek/ratechange). Within this window, conflicting
// playback updates from other actors are treated as passive follows.
const PLAYBACK_AUTHORITY_WINDOW_MS = 1200;
// How often (at most) recordPlaybackAuthority sweeps the whole map for expired
// entries. getPlaybackAuthority only evicts the room it is asked about, so this
// bounded sweep keeps rooms that are never read again from leaking.
const PLAYBACK_AUTHORITY_SWEEP_INTERVAL_MS = 60_000;

export type PlaybackAcceptanceDecision =
  | { decision: "accept"; reason: "same-actor" | "no-current" | "default" }
  | {
      decision: "ignore-as-follow";
      reason: "authority-window-follow";
    }
  | {
      decision: "ignore-stale-like";
      reason: "timeline-regression";
    };

export function decidePlaybackAcceptance(args: {
  currentPlayback: PlaybackState | null;
  authority: PlaybackAuthority | null;
  incomingPlayback: PlaybackState;
  currentTime: number;
}): PlaybackAcceptanceDecision {
  if (!args.currentPlayback) {
    return { decision: "accept", reason: "no-current" };
  }

  if (args.currentPlayback.actorId === args.incomingPlayback.actorId) {
    return { decision: "accept", reason: "same-actor" };
  }

  const currentIsStopLike =
    args.currentPlayback.playState === "paused" ||
    args.currentPlayback.playState === "buffering";
  const incomingIsPlaying = args.incomingPlayback.playState === "playing";
  const incomingIsStopLike =
    args.incomingPlayback.playState === "paused" ||
    args.incomingPlayback.playState === "buffering";
  const incomingIsExplicitControl = isExplicitControlSyncIntent(
    args.incomingPlayback.syncIntent,
  );
  const authority = args.authority;
  const withinAuthorityWindow =
    authority !== null && args.currentTime < authority.until;
  const authorityPrefersPlaybackContinuity =
    authority?.kind === "play" ||
    authority?.kind === "seek" ||
    authority?.kind === "ratechange" ||
    authority?.kind === "share";
  const authorityOwnsCurrentPlayback =
    authority !== null &&
    args.currentPlayback.actorId === authority.actorId &&
    args.currentPlayback.playState === "playing";
  const closeInTimeline =
    Math.abs(
      args.incomingPlayback.currentTime - args.currentPlayback.currentTime,
    ) < 1.2;
  const nonAdvancingStopLike =
    args.incomingPlayback.currentTime <=
    args.currentPlayback.currentTime + 0.15;
  const driftsBackBehindCurrent =
    args.incomingPlayback.currentTime + 0.6 < args.currentPlayback.currentTime;

  if (
    !incomingIsExplicitControl &&
    withinAuthorityWindow &&
    authority.actorId !== args.incomingPlayback.actorId &&
    incomingIsPlaying &&
    (currentIsStopLike ||
      closeInTimeline ||
      (authorityPrefersPlaybackContinuity && authorityOwnsCurrentPlayback))
  ) {
    return {
      decision: "ignore-as-follow",
      reason: "authority-window-follow",
    };
  }

  if (
    !incomingIsExplicitControl &&
    withinAuthorityWindow &&
    authority.actorId !== args.incomingPlayback.actorId &&
    authorityPrefersPlaybackContinuity &&
    incomingIsStopLike &&
    !currentIsStopLike &&
    closeInTimeline &&
    nonAdvancingStopLike
  ) {
    return {
      decision: "ignore-as-follow",
      reason: "authority-window-follow",
    };
  }

  if (
    !incomingIsExplicitControl &&
    incomingIsPlaying &&
    driftsBackBehindCurrent
  ) {
    return {
      decision: "ignore-stale-like",
      reason: "timeline-regression",
    };
  }

  return { decision: "accept", reason: "default" };
}

/**
 * Tracks the current playback authority per room. Owns the authority map and
 * its sweep bookkeeping so room-service doesn't have to keep this mutable
 * state in its top-level closure. Behavior is identical to the previous inline
 * implementation:
 *   - get(): returns the room's live authority, evicting it lazily if expired.
 *   - record(): sweeps expired entries (throttled), then opens a fresh window.
 *   - deriveKind(): pure classification of what kind of control an incoming
 *     playback transition represents (play/pause/seek/ratechange), or null.
 */
export interface PlaybackAuthorityTracker {
  get(roomCode: string): PlaybackAuthority | null;
  record(args: {
    roomCode: string;
    actorId: string;
    kind: PlaybackAuthority["kind"];
    source: PlaybackAuthority["source"];
  }): void;
  deriveKind(args: {
    currentPlayback: PlaybackState | null;
    nextPlayback: PlaybackState;
  }): PlaybackAuthority["kind"] | null;
}

export function createPlaybackAuthorityTracker(args: {
  now: () => number;
}): PlaybackAuthorityTracker {
  const { now } = args;
  const authorityByRoom = new Map<string, PlaybackAuthority>();
  let lastSweepAt = 0;

  function sweepExpired(currentTime: number): void {
    if (currentTime - lastSweepAt < PLAYBACK_AUTHORITY_SWEEP_INTERVAL_MS) {
      return;
    }
    lastSweepAt = currentTime;
    for (const [roomCode, authority] of authorityByRoom) {
      if (authority.until <= currentTime) {
        authorityByRoom.delete(roomCode);
      }
    }
  }

  return {
    get(roomCode) {
      const authority = authorityByRoom.get(roomCode) ?? null;
      if (!authority) {
        return null;
      }
      if (authority.until <= now()) {
        authorityByRoom.delete(roomCode);
        return null;
      }
      return authority;
    },
    record(recordArgs) {
      sweepExpired(now());
      authorityByRoom.set(recordArgs.roomCode, {
        actorId: recordArgs.actorId,
        until: now() + PLAYBACK_AUTHORITY_WINDOW_MS,
        kind: recordArgs.kind,
        source: recordArgs.source,
      });
    },
    deriveKind(deriveArgs) {
      if (!deriveArgs.currentPlayback) {
        return "play";
      }
      if (
        deriveArgs.nextPlayback.playState === "paused" ||
        deriveArgs.nextPlayback.playState === "buffering"
      ) {
        return "pause";
      }
      if (
        Math.abs(
          deriveArgs.nextPlayback.playbackRate -
            deriveArgs.currentPlayback.playbackRate,
        ) > 0.01
      ) {
        return "ratechange";
      }
      if (
        deriveArgs.nextPlayback.syncIntent === "explicit-seek" &&
        deriveArgs.nextPlayback.playState === "playing"
      ) {
        return "seek";
      }
      if (
        Math.abs(
          deriveArgs.nextPlayback.currentTime -
            deriveArgs.currentPlayback.currentTime,
        ) >= 2.5
      ) {
        return "seek";
      }
      if (
        deriveArgs.currentPlayback.playState !== "playing" &&
        deriveArgs.nextPlayback.playState === "playing"
      ) {
        return "play";
      }
      return null;
    },
  };
}
