import { t } from "../shared/i18n";

/**
 * Shadow-DOM markup + styles for the floating page-share button and its
 * popover. Extracted verbatim from page-share-button.ts's `ensureMounted`
 * (previously ~500 inline lines) so the controller keeps only wiring logic.
 * The two size constants are passed in to avoid duplicating them across files.
 */
export function buildPageShareButtonTemplate(args: {
  buttonSize: number;
  popoverWidth: number;
}): string {
  const BUTTON_SIZE = args.buttonSize;
  const POPOVER_WIDTH = args.popoverWidth;
  return `
      <style>
        :host {
          all: initial;
        }
        .share-button {
          position: absolute;
          width: ${BUTTON_SIZE}px;
          height: ${BUTTON_SIZE}px;
          padding: 0;
          border: 0;
          border-radius: 999px;
          background: #ff5a8a;
          color: #ffffff;
          box-shadow: 0 8px 18px rgba(255, 90, 138, 0.28), 0 2px 8px rgba(27, 31, 45, 0.16);
          box-sizing: border-box;
          cursor: grab;
          pointer-events: auto;
          z-index: 1;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          touch-action: none;
          transition: background 0.16s ease, opacity 0.16s ease, transform 0.16s ease;
        }
        .share-button svg {
          width: 20px;
          height: 20px;
          display: block;
          pointer-events: none;
        }
        .share-button:hover {
          background: #ff4b81;
          transform: translateY(-1px);
        }
        .share-button:active,
        .share-button.is-dragging {
          cursor: grabbing;
          transform: translateY(0);
        }
        .share-button:focus-visible {
          outline: 3px solid rgba(255, 90, 138, 0.28);
          outline-offset: 2px;
        }
        .share-button:disabled {
          cursor: default;
          opacity: 0.72;
          transform: none;
        }
        .share-button[aria-busy="true"] svg {
          animation: spin 0.8s linear infinite;
        }
        .share-popover {
          position: absolute;
          width: ${POPOVER_WIDTH}px;
          padding: 10px;
          border: 1px solid rgba(255, 90, 138, 0.22);
          border-radius: 8px;
          background: rgba(255, 255, 255, 0.98);
          color: #242631;
          box-shadow: 0 10px 24px rgba(27, 31, 45, 0.14), 0 2px 8px rgba(27, 31, 45, 0.08);
          box-sizing: border-box;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei UI", "PingFang SC", sans-serif;
          pointer-events: auto;
          z-index: 1;
          opacity: 0;
          transform: translateY(2px);
          transition: opacity 0.12s ease, transform 0.12s ease;
        }
        .share-popover[hidden] {
          display: none;
        }
        .share-popover.is-visible {
          opacity: 1;
          transform: translateY(0);
        }
        .popover-backdrop {
          position: absolute;
          inset: 0;
          z-index: 0;
          background: transparent;
          pointer-events: auto;
        }
        .popover-backdrop[hidden] {
          display: none;
        }
        .popover-heading {
          margin: 0 0 8px;
          font-size: 13px;
          font-weight: 650;
          line-height: 18px;
        }
        .popover-status {
          margin: 0;
          color: #5b6070;
          font-size: 12px;
          line-height: 18px;
        }
        .popover-section {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .popover-section[hidden] {
          display: none;
        }
        .popover-section + .popover-section {
          margin-top: 8px;
          padding-top: 8px;
          border-top: 1px solid rgba(27, 31, 45, 0.08);
        }
        .popover-row {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 12px;
          line-height: 17px;
        }
        .popover-row-label {
          flex: 0 0 auto;
          color: #767b8c;
          font-weight: 500;
        }
        .popover-row-value {
          flex: 1 1 auto;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          color: #242631;
        }
        .popover-room-code-row {
          justify-content: space-between;
        }
        .popover-room-code-value {
          font-family: ui-monospace, "SFMono-Regular", "Menlo", monospace;
          font-weight: 600;
        }
        .popover-link-button {
          flex: 0 0 auto;
          background: none;
          border: 1px solid rgba(27, 31, 45, 0.12);
          border-radius: 4px;
          padding: 3px 8px;
          font: 500 12px/1.2 inherit;
          color: #ff5a8a;
          cursor: pointer;
          transition: background 0.15s, border-color 0.15s, color 0.15s;
        }
        .popover-link-button:hover:not(:disabled) {
          background: rgba(255, 90, 138, 0.08);
          border-color: rgba(255, 90, 138, 0.3);
        }
        .popover-link-button:focus-visible {
          outline: 2px solid rgba(255, 90, 138, 0.5);
          outline-offset: 1px;
        }
        .popover-link-button:disabled {
          opacity: 0.6;
          cursor: default;
        }
        .popover-link-button.is-copied {
          background: rgba(0, 161, 102, 0.1);
          border-color: rgba(0, 161, 102, 0.3);
          color: #00a166;
        }
        .popover-form {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .popover-input-row {
          display: flex;
          gap: 6px;
        }
        .popover-input {
          flex: 1 1 auto;
          min-width: 0;
          padding: 6px 8px;
          border: 1px solid rgba(27, 31, 45, 0.16);
          border-radius: 4px;
          font: 500 12px/1.2 inherit;
          color: #242631;
          background: #ffffff;
          outline: none;
          transition: border-color 0.15s, box-shadow 0.15s;
        }
        .popover-input:focus {
          border-color: #ff5a8a;
          box-shadow: 0 0 0 2px rgba(255, 90, 138, 0.18);
        }
        .popover-input:disabled {
          background: #f4f5f8;
          color: #999;
        }
        .popover-button {
          flex: 0 0 auto;
          background: #ff5a8a;
          color: #ffffff;
          border: 1px solid transparent;
          border-radius: 4px;
          padding: 6px 12px;
          font: 600 12px/1.2 inherit;
          cursor: pointer;
          transition: background 0.15s, opacity 0.15s;
        }
        .popover-button:hover:not(:disabled) {
          background: #ff4b81;
        }
        .popover-button:focus-visible {
          outline: 2px solid rgba(255, 90, 138, 0.5);
          outline-offset: 1px;
        }
        .popover-button:disabled {
          opacity: 0.6;
          cursor: default;
        }
        .popover-quick-create-button {
          width: 100%;
          padding: 7px 12px;
          margin-bottom: 2px;
        }
        .popover-shared-video-row {
          flex-direction: column;
          align-items: stretch;
          gap: 3px;
        }
        .popover-shared-video-value {
          flex: none;
          white-space: normal;
          word-break: break-word;
          overflow: visible;
          text-overflow: clip;
          line-height: 1.4;
          font-weight: 500;
        }
        .popover-shared-video-value.is-empty {
          color: #999;
          font-style: italic;
          font-weight: 400;
        }
        .popover-sync-hint {
          margin: 4px 0 0;
          padding: 6px 8px;
          border-radius: 4px;
          background: rgba(255, 90, 138, 0.06);
          color: #a05682;
          font-size: 11.5px;
          line-height: 1.5;
        }
        .popover-nickname-row {
          flex-wrap: wrap;
        }
        .popover-nickname-input {
          flex: 1 1 100px;
          min-width: 0;
        }
        .popover-inline-actions {
          display: flex;
          gap: 6px;
          flex: 0 0 auto;
        }
        .popover-inline-actions .popover-button {
          padding: 4px 10px;
        }
        .popover-button.is-ghost {
          background: transparent;
          color: #5b6070;
          border-color: rgba(27, 31, 45, 0.16);
        }
        .popover-button.is-ghost:hover:not(:disabled) {
          background: rgba(27, 31, 45, 0.05);
          color: #242631;
        }
        .popover-button.is-danger {
          background: transparent;
          color: #d44c4c;
          border-color: rgba(212, 76, 76, 0.3);
        }
        .popover-button.is-danger:hover:not(:disabled) {
          background: rgba(212, 76, 76, 0.08);
        }
        .popover-members {
          list-style: none;
          margin: 0;
          padding: 0;
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
        }
        .popover-member-chip {
          background: rgba(255, 90, 138, 0.1);
          color: #c43d6e;
          padding: 3px 8px;
          border-radius: 999px;
          font-size: 11px;
          line-height: 14px;
          font-weight: 500;
        }
        .popover-member-chip.is-self {
          background: rgba(0, 161, 214, 0.14);
          color: #0078a0;
        }
        .popover-error {
          color: #d44c4c;
          font-size: 11px;
          line-height: 16px;
          margin: 0;
        }
        .quick-toggle {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          margin-top: 10px;
          padding-top: 9px;
          border-top: 1px solid rgba(27, 31, 45, 0.08);
          color: #4a4f5d;
          cursor: pointer;
          font-size: 12px;
          line-height: 18px;
        }
        .quick-toggle-switch {
          position: relative;
          display: inline-flex;
          flex: 0 0 auto;
          width: 32px;
          height: 18px;
          align-items: center;
        }
        .quick-toggle-input {
          position: absolute;
          inset: 0;
          margin: 0;
          cursor: pointer;
          opacity: 0;
        }
        .quick-toggle-track {
          position: absolute;
          inset: 0;
          border-radius: 999px;
          background: #d6dae3;
          transition: background 0.16s ease;
        }
        .quick-toggle-thumb {
          position: absolute;
          top: 2px;
          left: 2px;
          width: 14px;
          height: 14px;
          border-radius: 999px;
          background: #ffffff;
          box-shadow: 0 1px 3px rgba(27, 31, 45, 0.18);
          transition: transform 0.16s ease;
        }
        .quick-toggle-input:checked + .quick-toggle-track {
          background: #ff5a8a;
        }
        .quick-toggle-input:checked + .quick-toggle-track .quick-toggle-thumb {
          transform: translateX(14px);
        }
        .quick-toggle-input:focus-visible + .quick-toggle-track {
          outline: 2px solid rgba(255, 90, 138, 0.26);
          outline-offset: 2px;
        }
        .quick-toggle-input:disabled {
          cursor: wait;
        }
        .quick-toggle-input:disabled + .quick-toggle-track {
          opacity: 0.72;
        }
        @keyframes spin {
          to {
            transform: rotate(360deg);
          }
        }
        @media (prefers-color-scheme: dark) {
          .share-button {
            background: #ff6b96;
            box-shadow: 0 8px 18px rgba(255, 107, 150, 0.24), 0 2px 10px rgba(0, 0, 0, 0.28);
          }
          .share-button:hover {
            background: #ff7aa1;
          }
          .share-popover {
            border-color: rgba(255, 107, 150, 0.22);
            background: rgba(31, 34, 43, 0.98);
            color: #f4f5f8;
            box-shadow: 0 10px 24px rgba(0, 0, 0, 0.28), 0 2px 8px rgba(0, 0, 0, 0.2);
          }
          .popover-status,
          .quick-toggle {
            color: #b8becd;
          }
          .popover-section + .popover-section {
            border-top-color: rgba(255, 255, 255, 0.1);
          }
          .popover-row-label {
            color: #9499a0;
          }
          .popover-row-value {
            color: #f4f5f8;
          }
          .popover-link-button {
            background: transparent;
            border-color: rgba(255, 255, 255, 0.16);
            color: #ff85a9;
          }
          .popover-link-button:hover:not(:disabled) {
            background: rgba(255, 107, 150, 0.12);
            border-color: rgba(255, 107, 150, 0.4);
          }
          .popover-link-button.is-copied {
            background: rgba(102, 187, 51, 0.12);
            border-color: rgba(102, 187, 51, 0.4);
            color: #80d965;
          }
          .popover-input {
            background: rgba(255, 255, 255, 0.04);
            border-color: rgba(255, 255, 255, 0.16);
            color: #f4f5f8;
          }
          .popover-input:focus {
            border-color: #ff85a9;
            box-shadow: 0 0 0 2px rgba(255, 107, 150, 0.18);
          }
          .popover-input:disabled {
            background: rgba(255, 255, 255, 0.02);
            color: #666;
          }
          .popover-button {
            background: #ff6b96;
          }
          .popover-button:hover:not(:disabled) {
            background: #ff85a9;
          }
          .popover-button.is-ghost {
            background: transparent;
            color: #b8becd;
            border-color: rgba(255, 255, 255, 0.16);
          }
          .popover-button.is-ghost:hover:not(:disabled) {
            background: rgba(255, 255, 255, 0.05);
            color: #f4f5f8;
          }
          .popover-button.is-danger {
            color: #f08080;
            border-color: rgba(240, 128, 128, 0.3);
          }
          .popover-button.is-danger:hover:not(:disabled) {
            background: rgba(240, 128, 128, 0.08);
          }
          .popover-member-chip {
            background: rgba(255, 107, 150, 0.16);
            color: #ffadc4;
          }
          .popover-member-chip.is-self {
            background: rgba(0, 161, 214, 0.16);
            color: #6ec3d8;
          }
          .popover-error {
            color: #f08080;
          }
          .quick-toggle {
            border-top-color: rgba(255, 255, 255, 0.1);
          }
          .quick-toggle-track {
            background: #5b6070;
          }
        }
      </style>
      <div class="popover-backdrop" hidden></div>
      <button class="share-button" type="button">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path fill="currentColor" d="M21 0H3a3 3 0 0 0-3 3v9a3 3 0 0 0 3 3h18a3 3 0 0 0 3-3V3a3 3 0 0 0-3-3m1 12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h18a1 1 0 0 1 1 1Z"></path>
          <path fill="currentColor" d="M9.54 3.79a.37.37 0 0 0-.41 0a.6.6 0 0 0-.19.45v6.42a.6.6 0 0 0 .19.45a.37.37 0 0 0 .41.05l5.58-2.94a.88.88 0 0 0 0-1.53ZM4.5 18a3 3 0 0 0-3 3v2.5a.5.5 0 0 0 .5.5h5a.5.5 0 0 0 .5-.5V21a3 3 0 0 0-3-3m7.5 0a3 3 0 0 0-3 3v2.5a.5.5 0 0 0 .5.5h5a.5.5 0 0 0 .5-.5V21a3 3 0 0 0-3-3m7.5 0a3 3 0 0 0-3 3v2.5a.5.5 0 0 0 .5.5h5a.5.5 0 0 0 .5-.5V21a3 3 0 0 0-3-3"></path>
        </svg>
      </button>
      <div class="share-popover" hidden role="dialog" aria-label="${t("pageSharePopoverTitle")}">
        <div class="popover-heading">${t("pageSharePopoverTitle")}</div>
        <p class="popover-status" hidden></p>
        <div class="popover-section popover-section-join" hidden>
          <button class="popover-button popover-quick-create-button" type="button">${t("pageShareQuickCreate")}</button>
          <form class="popover-form popover-join-form">
            <div class="popover-input-row">
              <input class="popover-input popover-join-input" type="text" inputmode="numeric" maxlength="4" autocomplete="off" placeholder="${t("pageShareJoinPlaceholder")}" aria-label="${t("pageShareJoinPlaceholder")}">
              <button class="popover-button popover-join-button" type="submit">${t("pageShareJoin")}</button>
            </div>
            <p class="popover-error popover-join-error" hidden></p>
          </form>
        </div>
        <div class="popover-section popover-section-joined" hidden>
          <div class="popover-row popover-room-code-row">
            <span class="popover-row-label">${t("pageShareRoomCode")}</span>
            <span class="popover-row-value popover-room-code-value" title=""></span>
            <button class="popover-link-button popover-copy-button" type="button">${t("pageShareRoomCodeCopy")}</button>
          </div>
          <div class="popover-row popover-shared-video-row">
            <span class="popover-row-label">${t("pageShareSharedVideo")}</span>
            <span class="popover-row-value popover-shared-video-value" title=""></span>
          </div>
          <p class="popover-sync-hint">${t("pageShareSyncHint")}</p>
          <div class="popover-row popover-nickname-row">
            <span class="popover-row-label">${t("pageShareNickname")}</span>
            <span class="popover-row-value popover-nickname-value" title=""></span>
            <input class="popover-input popover-nickname-input" type="text" maxlength="32" autocomplete="off" aria-label="${t("pageShareNickname")}" hidden>
            <button class="popover-link-button popover-edit-nickname-button" type="button">${t("pageShareNicknameEdit")}</button>
          </div>
          <p class="popover-error popover-nickname-error" hidden></p>
          <div class="popover-row popover-members-row">
            <span class="popover-row-label">${t("pageShareMembersHeading", { count: 0 })}</span>
            <ul class="popover-members"></ul>
          </div>
          <button class="popover-button is-danger popover-leave-button" type="button">${t("pageShareLeaveRoom")}</button>
        </div>
        <label class="quick-toggle">
          <span>${t("pageShareButtonQuickDisable")}</span>
          <span class="quick-toggle-switch">
            <input class="quick-toggle-input" type="checkbox" checked aria-label="${t("pageShareButtonQuickDisable")}">
            <span class="quick-toggle-track" aria-hidden="true">
              <span class="quick-toggle-thumb"></span>
            </span>
          </span>
        </label>
      </div>
`;
}
