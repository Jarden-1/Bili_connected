import { randomUUID } from "node:crypto";
import { shouldIncludeRuntimeEvent } from "./event-visibility.js";
import type { RuntimeEvent } from "./types.js";
import type {
  GlobalEventStore,
  GlobalEventStoreQuery,
} from "./global-event-store.js";

export type EventStore = GlobalEventStore;
export type EventStoreQuery = GlobalEventStoreQuery;

const MINUTE_MS = 60_000;
const MINUTE_BUCKET_RETENTION = 24 * 60;

export function createEventStore(capacity = 1_000): EventStore {
  const events: RuntimeEvent[] = [];
  const cumulativeCounts = new Map<string, number>();
  const minuteBuckets = new Map<string, Map<number, number>>();

  function eventTime(event: RuntimeEvent): number {
    return Date.parse(event.timestamp);
  }

  function pruneMinuteBuckets(currentMinute: number): void {
    // Keep MINUTE_BUCKET_RETENTION + 1 buckets (current minute plus the
    // retention window of past minutes) so callers that pass a 24h ms range
    // covering up to 1441 minute indices still see the boundary bucket.
    const oldestKept = currentMinute - MINUTE_BUCKET_RETENTION;
    for (const buckets of minuteBuckets.values()) {
      for (const minute of buckets.keys()) {
        if (minute < oldestKept) {
          buckets.delete(minute);
        }
      }
    }
  }

  function recordMinuteBucket(eventName: string, timestampMs: number): void {
    const minute = Math.floor(timestampMs / MINUTE_MS);
    let buckets = minuteBuckets.get(eventName);
    if (!buckets) {
      buckets = new Map();
      minuteBuckets.set(eventName, buckets);
    }
    buckets.set(minute, (buckets.get(minute) ?? 0) + 1);
    pruneMinuteBuckets(minute);
  }

  return {
    async append(input) {
      const event: RuntimeEvent = {
        id: randomUUID(),
        timestamp: input.timestamp ?? new Date().toISOString(),
        event: input.event,
        roomCode:
          typeof input.data.roomCode === "string" ? input.data.roomCode : null,
        sessionId:
          typeof input.data.sessionId === "string"
            ? input.data.sessionId
            : null,
        remoteAddress:
          typeof input.data.remoteAddress === "string"
            ? input.data.remoteAddress
            : null,
        origin:
          typeof input.data.origin === "string" ? input.data.origin : null,
        result:
          typeof input.data.result === "string" ? input.data.result : null,
        details: { ...input.data },
      };

      events.push(event);
      cumulativeCounts.set(
        event.event,
        (cumulativeCounts.get(event.event) ?? 0) + 1,
      );
      recordMinuteBucket(event.event, eventTime(event));
      if (events.length > capacity) {
        events.shift();
      }
      return event;
    },
    async query(query) {
      const filtered = events.filter((event) => {
        const timestamp = eventTime(event);
        if (
          !shouldIncludeRuntimeEvent(event.event, query.includeSystem === true)
        ) {
          return false;
        }
        if (query.event && event.event !== query.event) {
          return false;
        }
        if (query.roomCode && event.roomCode !== query.roomCode) {
          return false;
        }
        if (query.sessionId && event.sessionId !== query.sessionId) {
          return false;
        }
        if (
          query.remoteAddress &&
          event.remoteAddress !== query.remoteAddress
        ) {
          return false;
        }
        if (query.origin && event.origin !== query.origin) {
          return false;
        }
        if (query.result && event.result !== query.result) {
          return false;
        }
        if (query.from !== undefined && timestamp < query.from) {
          return false;
        }
        if (query.to !== undefined && timestamp > query.to) {
          return false;
        }
        return true;
      });

      filtered.sort((left, right) => eventTime(right) - eventTime(left));
      const start = (query.page - 1) * query.pageSize;
      return {
        items: filtered.slice(start, start + query.pageSize),
        total: filtered.length,
      };
    },
    totalCountsByEvent(eventNames) {
      return Object.fromEntries(
        eventNames.map((name) => [name, cumulativeCounts.get(name) ?? 0]),
      );
    },
    countsByEventInWindow(eventNames, fromMs, toMs) {
      // Preferred path: when the in-memory ring buffer reaches back to (or
      // before) fromMs, every event in the window is still present, so we
      // can count by literal ms timestamp and avoid the minute-bucket
      // boundary fuzziness entirely.
      const bufferCoversWindow =
        events.length === 0 || eventTime(events[0]) <= fromMs;
      const wanted = new Set(eventNames);
      if (bufferCoversWindow) {
        const counts = Object.fromEntries(
          eventNames.map((name) => [name, 0]),
        ) as Record<string, number>;
        for (const event of events) {
          if (!wanted.has(event.event)) continue;
          const ts = eventTime(event);
          if (ts >= fromMs && ts <= toMs) {
            counts[event.event] += 1;
          }
        }
        return counts;
      }

      // Fallback: high-volume case where the buffer has rolled past fromMs.
      // Sum minute buckets that overlap [fromMs, toMs] — slight over-count
      // bounded by the events in the leading partial bucket (at most one
      // minute's worth), but never under-counts.
      const fromMinute = Math.floor(fromMs / MINUTE_MS);
      const toMinute = Math.floor(toMs / MINUTE_MS);
      return Object.fromEntries(
        eventNames.map((name) => {
          const buckets = minuteBuckets.get(name);
          if (!buckets) {
            return [name, 0];
          }
          let total = 0;
          for (const [minute, count] of buckets) {
            if (minute >= fromMinute && minute <= toMinute) {
              total += count;
            }
          }
          return [name, total];
        }),
      );
    },
  };
}
