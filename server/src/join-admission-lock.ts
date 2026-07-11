import { randomUUID } from "node:crypto";
import type { RuntimeStore } from "./runtime-store.js";
import type { LogEvent } from "./types.js";

// Namespaced key under which the per-room distributed join lock is stored in
// the runtime store. All nodes contend on the same key per room.
const JOIN_ADMISSION_LOCK_KEY = "join-admission";
// How long a freshly acquired distributed lock stays valid before its TTL
// lets another node take over (guards against a crashed holder).
const JOIN_ADMISSION_LOCK_TTL_MS = 30_000;
// Upper bound on how long acquireDistributedJoinLock will spin waiting for the
// lock before giving up and reporting a timeout.
const JOIN_ADMISSION_LOCK_MAX_WAIT_MS = 5_000;
// Delay between contention retries while spinning for the distributed lock.
const JOIN_ADMISSION_LOCK_RETRY_INTERVAL_MS = 25;

type JoinAdmissionLock = {
  token: string;
  expiresAt: number;
};

// Passed to the guarded action so it can re-assert the lock is still held
// (i.e. hasn't hit its TTL) before performing a critical write.
export type JoinAdmissionLockGuard = {
  assertActive: () => void;
};

// Error factories injected by room-service so this module can throw the same
// RoomServiceError instances without importing (and depending back on)
// room-service — keeps the dependency one-directional.
export interface JoinAdmissionLockErrors {
  lockTimeout(roomCode: string): Error;
  lockExpired(roomCode: string): Error;
}

export interface JoinAdmissionLockController {
  /**
   * Serializes join admission per room: first queues behind any in-process
   * join for the same room, then acquires a cross-node distributed lock, runs
   * `action`, and always releases both. Throws errors.lockTimeout if the
   * distributed lock can't be acquired within the wait budget.
   */
  withLock<T>(
    roomCode: string,
    action: (lock: JoinAdmissionLockGuard) => Promise<T>,
  ): Promise<T>;
}

export function createJoinAdmissionLock(args: {
  runtimeStore: RuntimeStore;
  now: () => number;
  logEvent: LogEvent;
  errors: JoinAdmissionLockErrors;
}): JoinAdmissionLockController {
  const { runtimeStore, now, logEvent, errors } = args;
  // In-process serialization: a chain of promises per room so overlapping
  // joins on the same node run one at a time before contending for the
  // cross-node lock.
  const roomJoinLocks = new Map<string, Promise<void>>();

  async function acquireDistributedJoinLock(
    roomCode: string,
  ): Promise<JoinAdmissionLock | null> {
    const deadline = now() + JOIN_ADMISSION_LOCK_MAX_WAIT_MS;
    while (true) {
      const expiresAt = now() + JOIN_ADMISSION_LOCK_TTL_MS;
      const token = randomUUID();
      if (
        await runtimeStore.acquireRoomLock(
          roomCode,
          JOIN_ADMISSION_LOCK_KEY,
          token,
          expiresAt,
        )
      ) {
        return { token, expiresAt };
      }
      if (now() >= deadline) {
        return null;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, JOIN_ADMISSION_LOCK_RETRY_INTERVAL_MS),
      );
    }
  }

  async function withLock<T>(
    roomCode: string,
    action: (lock: JoinAdmissionLockGuard) => Promise<T>,
  ): Promise<T> {
    const previous = roomJoinLocks.get(roomCode) ?? Promise.resolve();
    let releaseNext: () => void = () => undefined;
    const next = new Promise<void>((resolve) => {
      releaseNext = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => next);
    roomJoinLocks.set(roomCode, tail);

    function releaseInProcessLock(): void {
      releaseNext();
      if (roomJoinLocks.get(roomCode) === tail) {
        roomJoinLocks.delete(roomCode);
      }
    }

    let distributedLock: JoinAdmissionLock | null = null;
    try {
      await previous.catch(() => undefined);
      distributedLock = await acquireDistributedJoinLock(roomCode);
      if (!distributedLock) {
        logEvent("room_join_admission_lock_unavailable", {
          roomCode,
          result: "rejected",
          reason: "join_admission_lock_timeout",
        });
        throw errors.lockTimeout(roomCode);
      }

      const lockGuard: JoinAdmissionLockGuard = {
        assertActive: () => {
          if (!distributedLock || now() >= distributedLock.expiresAt) {
            throw errors.lockExpired(roomCode);
          }
        },
      };

      return await action(lockGuard);
    } finally {
      if (distributedLock) {
        if (now() < distributedLock.expiresAt) {
          try {
            await runtimeStore.releaseRoomLock(
              roomCode,
              JOIN_ADMISSION_LOCK_KEY,
              distributedLock.token,
            );
          } catch {
            // Lock will expire via TTL.
          }
        } else {
          logEvent("room_join_admission_lock_ttl_exceeded", {
            roomCode,
            result: "rejected",
            reason: "join_admission_lock_ttl_exceeded",
            ttlMs: JOIN_ADMISSION_LOCK_TTL_MS,
          });
        }
      }
      releaseInProcessLock();
    }
  }

  return { withLock };
}
