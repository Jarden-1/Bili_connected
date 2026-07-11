import test from "node:test";
import assert from "node:assert/strict";
import {
  escapeHtml,
  formatInviteDraft,
  parseInviteValue,
} from "../src/popup/helpers";

test("escapeHtml escapes html-sensitive characters", () => {
  assert.equal(
    escapeHtml(`a&b<c>"d"'e`),
    "a&amp;b&lt;c&gt;&quot;d&quot;&#39;e",
  );
});

test("escapeHtml tolerates undefined and null values", () => {
  assert.equal(escapeHtml(undefined), "");
  assert.equal(escapeHtml(null), "");
});

test("escapeHtml coerces non-string values safely", () => {
  assert.equal(escapeHtml(123), "123");
  assert.equal(escapeHtml(false), "false");
});

test("parseInviteValue extracts roomCode and joinToken from an invite string", () => {
  assert.deepEqual(parseInviteValue("1234:join-token-123456"), {
    roomCode: "1234",
    joinToken: "join-token-123456",
  });
});

test("parseInviteValue accepts a bare 4-digit room code as a public join", () => {
  assert.deepEqual(parseInviteValue("1234"), {
    roomCode: "1234",
    joinToken: null,
  });
});

test("formatInviteDraft omits the joinToken segment for public joins", () => {
  // 4-digit room codes are public: the join token is never appended even
  // when the caller knows one (e.g. an older room still carrying a stored
  // token), because the server will accept the bare code.
  assert.equal(
    formatInviteDraft({ roomCode: "1234", joinToken: null }),
    "1234",
  );
  assert.equal(
    formatInviteDraft({ roomCode: "1234", joinToken: "join-token-123456" }),
    "1234",
  );
  assert.equal(formatInviteDraft(null), "");
});

test("parseInviteValue returns null for malformed input", () => {
  assert.equal(parseInviteValue("ABC123"), null);
  assert.equal(parseInviteValue(""), null);
  assert.equal(parseInviteValue("AB12:join-token-123456"), null);
  assert.equal(parseInviteValue("123:join-token-123456"), null);
  assert.equal(parseInviteValue("12345:join-token-123456"), null);
});
