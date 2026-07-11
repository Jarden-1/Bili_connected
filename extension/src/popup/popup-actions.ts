import type { BackgroundPopupState } from "../shared/messages";
import { getUiLanguage, t } from "../shared/i18n";
import { areSharedVideoUrlsEqual } from "../shared/url";
import { formatInviteDraft, parseInviteValue } from "./helpers";
import { sendPopupAction, sendPopupActiveVideoQuery } from "./popup-port";
import type { PopupUiStateStore } from "./popup-store";
import {
  syncServerUrlDraft,
  updateServerUrlDraft,
  type ServerUrlDraftState,
} from "./server-url-draft";
import type { PopupRefs } from "./popup-view";

export function bindPopupActions(args: {
  refs: PopupRefs;
  leaveGuardMs: number;
  uiStateStore: PopupUiStateStore;
  serverUrlDraft: ServerUrlDraftState;
  queryState: () => Promise<BackgroundPopupState>;
  applyActionState: (state: BackgroundPopupState) => void;
  render: () => void;
  sendPopupLog: (message: string) => Promise<void>;
  applyRoomActionControlState: (refs: PopupRefs) => void;
  getPopupState: () => BackgroundPopupState | null;
}): void {
  const { refs } = args;

  refs.joinRoomButton.addEventListener("pointerdown", () => {
    const uiState = args.uiStateStore.getState();
    void args.sendPopupLog(
      `Join button pointerdown disabled=${refs.joinRoomButton.disabled} pending=${uiState.roomActionPending} inputDisabled=${refs.roomCodeInput.disabled}`,
    );
  });

  refs.leaveRoomButton.addEventListener("pointerdown", () => {
    const uiState = args.uiStateStore.getState();
    void args.sendPopupLog(
      `Leave button pointerdown disabled=${refs.leaveRoomButton.disabled} pending=${uiState.roomActionPending} room=${uiState.lastKnownRoomCode ?? "none"}`,
    );
  });

  refs.createRoomButton.addEventListener("click", async () => {
    if (args.uiStateStore.getState().roomActionPending) {
      void args.sendPopupLog(
        "Create room click ignored because room action is pending",
      );
      return;
    }
    void args.sendPopupLog("Create room button clicked");
    patchUiState({
      localRoomEntryPending: true,
      localStatusMessage: null,
      roomActionPending: true,
    });
    try {
      // The background stages the active tab's video before creating and
      // auto-shares it the moment room:created lands (race-free), so the popup
      // no longer needs to trigger a follow-up share here.
      const state = await sendPopupAction({ type: "popup:create-room" });
      args.applyActionState(state);
      void args.sendPopupLog("Create room message resolved");
      patchUiState({ roomActionPending: false });
    } finally {
      if (args.uiStateStore.getState().roomActionPending) {
        patchUiState({ roomActionPending: false });
      }
    }
  });

  refs.joinRoomButton.addEventListener("click", async () => {
    await joinRoom({
      inviteText: refs.roomCodeInput.value.trim(),
      reasonLabel: "Join button clicked",
      resolvedLabel: "Join message resolved",
      invalidLabel: "Join click ignored because invite string is invalid",
      pendingLabel: "Join click ignored because room action is pending",
    });
  });

  refs.leaveRoomButton.addEventListener("click", async () => {
    const uiState = args.uiStateStore.getState();
    if (uiState.roomActionPending) {
      void args.sendPopupLog(
        "Leave click ignored because room action is pending",
      );
      return;
    }
    if (Date.now() - uiState.lastRoomEnteredAt < args.leaveGuardMs) {
      void args.sendPopupLog(
        `Leave click ignored by recent-join guard ${Date.now() - uiState.lastRoomEnteredAt}ms`,
      );
      return;
    }
    void args.sendPopupLog("Leave room button clicked");
    patchUiState({
      localStatusMessage: null,
      roomCodeDraft: formatInviteDraft({
        roomCode: uiState.lastKnownRoomCode,
        joinToken: args.getPopupState()?.joinToken ?? null,
      }),
      roomActionPending: true,
    });
    try {
      const state = await sendPopupAction({ type: "popup:leave-room" });
      args.applyActionState(state);
      void args.sendPopupLog("Leave room message resolved");
      patchUiState({ roomActionPending: false });
    } finally {
      if (args.uiStateStore.getState().roomActionPending) {
        patchUiState({ roomActionPending: false });
      }
    }
  });

  refs.copyRoomButton.addEventListener("click", async () => {
    const roomCode = refs.roomStatus.textContent?.trim();
    const state = await args.queryState();
    if (!roomCode || roomCode === "-" || !state.joinToken) {
      return;
    }

    await navigator.clipboard.writeText(`${roomCode}:${state.joinToken}`);
    toggleCopySuccess("copyRoomSuccess");
  });

  refs.copyLogsButton.addEventListener("click", async () => {
    const state = await args.queryState();
    const text = state.logs
      .slice()
      .reverse()
      .map((entry) => {
        const time = new Date(entry.at).toLocaleTimeString(getUiLanguage(), {
          hour12: false,
        });
        return `[${time}] [${entry.scope}] ${entry.message}`;
      })
      .join("\n");

    await navigator.clipboard.writeText(text || t("stateNoLogs"));
    toggleCopySuccess("copyLogsSuccess");
  });

  refs.shareCurrentVideoButton.addEventListener("click", () => {
    void handleShareCurrentVideo();
  });

  refs.sharedVideoCard.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "popup:open-shared-video" });
    window.close();
  });

  refs.pageShareButtonEnabledInput.addEventListener("change", async () => {
    const state = await sendPopupAction({
      type: "popup:set-page-share-button-enabled",
      enabled: refs.pageShareButtonEnabledInput.checked,
    });
    args.applyActionState(state);
  });

  refs.nicknameEditButton.addEventListener("click", () => {
    if (args.uiStateStore.getState().nicknameEditing) {
      patchUiState({ nicknameEditing: false, localStatusMessage: null });
      return;
    }
    const current = args.getPopupState()?.displayName ?? "";
    refs.nicknameInput.value = current;
    patchUiState({ nicknameEditing: true, localStatusMessage: null });
    refs.nicknameInput.focus();
    refs.nicknameInput.select();
  });

  refs.nicknameInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void saveNickname();
    } else if (event.key === "Escape") {
      patchUiState({ nicknameEditing: false, localStatusMessage: null });
    }
  });

  refs.nicknameInput.addEventListener("focus", () => {
    patchUiState({ nicknameInputFocused: true });
  });
  refs.nicknameInput.addEventListener("blur", () => {
    patchUiState({ nicknameInputFocused: false });
  });

  async function saveNickname(): Promise<void> {
    const next = refs.nicknameInput.value.trim();
    if (!next) {
      return;
    }
    patchUiState({ localStatusMessage: null });
    const state = await sendPopupAction({
      type: "popup:set-display-name",
      displayName: next,
    });
    args.applyActionState(state);
    patchUiState({
      nicknameEditing: false,
      localStatusMessage: t("pageShareNicknameSaved"),
    });
  }

  refs.roomCodeInput.addEventListener("keydown", async (event) => {
    if (event.key !== "Enter") {
      return;
    }
    await joinRoom({
      inviteText: refs.roomCodeInput.value.trim(),
      reasonLabel: "Join by Enter",
      resolvedLabel: "Join by Enter resolved",
      invalidLabel: "Join by Enter ignored because invite string is invalid",
      pendingLabel: "Join by Enter ignored because room action is pending",
      event,
    });
  });

  refs.roomCodeInput.addEventListener("input", () => {
    args.applyRoomActionControlState(refs);
    const inviteText = refs.roomCodeInput.value.trim();
    const invite = parseInviteValue(inviteText);
    // Keep the input as-is when it is a bare 4-digit code; only reformat when
    // the user typed a full "roomCode:joinToken" pair (so the auto-complete
    // for known rooms still trims trailing whitespace).
    patchUiState({
      roomCodeDraft: invite ? formatInviteDraft(invite) : inviteText,
    });
    if (args.uiStateStore.getState().localStatusMessage) {
      patchUiState({ localStatusMessage: null });
    }
    if (invite) {
      void args.sendPopupLog(
        `Invite input changed room=${invite.roomCode} hasToken=${invite.joinToken ? "yes" : "no"}`,
      );
    }
  });

  const saveServerUrl = async () => {
    patchUiState({ localStatusMessage: null });
    const originalServerUrl = args.serverUrlDraft.value;
    const state = await sendPopupAction({
      type: "popup:set-server-url",
      serverUrl: originalServerUrl.trim(),
    });
    args.applyActionState(state);
    syncServerUrlDraft(args.serverUrlDraft, state.serverUrl);
    refs.serverUrlInput.value = state.serverUrl;
    if (originalServerUrl !== state.serverUrl && !state.error) {
      patchUiState({
        localStatusMessage: t("serverUrlAdjusted", {
          resolved: state.serverUrl,
        }),
      });
      return;
    }
    args.render();
  };

  refs.saveServerUrlButton.addEventListener("click", () => {
    void saveServerUrl();
  });

  refs.serverUrlInput.addEventListener("input", () => {
    updateServerUrlDraft(
      args.serverUrlDraft,
      refs.serverUrlInput.value,
      args.getPopupState()?.serverUrl ?? "",
    );
    if (args.uiStateStore.getState().localStatusMessage) {
      patchUiState({ localStatusMessage: null });
    }
  });

  refs.serverUrlInput.addEventListener("keydown", async (event) => {
    if (event.key !== "Enter") {
      return;
    }
    event.preventDefault();
    await saveServerUrl();
  });

  async function handleShareCurrentVideo(): Promise<void> {
    const state = args.getPopupState() ?? (await args.queryState());
    let activeVideo;
    try {
      activeVideo = await sendPopupActiveVideoQuery();
    } catch (error) {
      void args.sendPopupLog(
        `popup:get-active-video response guard rejected: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (args.getPopupState()) {
        args.render();
      }
      return;
    }
    if (!activeVideo.ok || !activeVideo.payload) {
      if (args.getPopupState()) {
        args.render();
      }
      return;
    }

    const currentVideo = activeVideo.payload.video;
    if (!state.roomCode) {
      const shouldCreateRoom = window.confirm(
        t("confirmCreateRoomBeforeShare"),
      );
      if (!shouldCreateRoom) {
        return;
      }
    } else if (
      state.roomState?.sharedVideo?.url &&
      !areSharedVideoUrlsEqual(
        state.roomState.sharedVideo.url,
        currentVideo.url,
      )
    ) {
      const shouldReplace = window.confirm(
        t("confirmReplaceSharedVideo", {
          currentTitle: state.roomState.sharedVideo.title,
          nextTitle: currentVideo.title,
        }),
      );
      if (!shouldReplace) {
        return;
      }
    }

    await chrome.runtime.sendMessage({ type: "popup:share-current-video" });
    if (args.getPopupState()) {
      args.render();
    }
  }

  async function joinRoom(args2: {
    inviteText: string;
    reasonLabel: string;
    resolvedLabel: string;
    invalidLabel: string;
    pendingLabel: string;
    event?: KeyboardEvent;
  }): Promise<void> {
    if (args2.event) {
      if (args2.event.key !== "Enter") {
        return;
      }
      if (args.uiStateStore.getState().roomActionPending) {
        void args.sendPopupLog(args2.pendingLabel);
        return;
      }
    } else if (args.uiStateStore.getState().roomActionPending) {
      void args.sendPopupLog(args2.pendingLabel);
      return;
    }

    const invite = parseInviteValue(args2.inviteText);
    if (!invite) {
      patchUiState({ localStatusMessage: t("errorInvalidInviteFormat") });
      void args.sendPopupLog(args2.invalidLabel);
      return;
    }
    patchUiState({
      localRoomEntryPending: true,
      localStatusMessage: null,
      roomCodeDraft: formatInviteDraft(invite),
    });
    void args.sendPopupLog(`${args2.reasonLabel} room=${invite.roomCode}`);
    patchUiState({ roomActionPending: true });
    try {
      const state = await sendPopupAction({
        type: "popup:join-room",
        roomCode: invite.roomCode,
        joinToken: invite.joinToken,
      });
      args.applyActionState(state);
      void args.sendPopupLog(`${args2.resolvedLabel} room=${invite.roomCode}`);
      patchUiState({ roomActionPending: false });
    } finally {
      if (args.uiStateStore.getState().roomActionPending) {
        patchUiState({ roomActionPending: false });
      }
    }
  }

  function patchUiState(
    nextState: Partial<ReturnType<PopupUiStateStore["getState"]>>,
  ): void {
    args.uiStateStore.patch(nextState);
    args.render();
  }

  function toggleCopySuccess(
    field: "copyRoomSuccess" | "copyLogsSuccess",
  ): void {
    const previousTimer = copyResetTimers.get(field);
    if (previousTimer !== undefined) {
      window.clearTimeout(previousTimer);
    }
    patchUiState({ [field]: true });
    const timer = window.setTimeout(() => {
      copyResetTimers.delete(field);
      patchUiState({ [field]: false });
    }, 1400);
    copyResetTimers.set(field, timer);
  }
}

const copyResetTimers = new Map<
  "copyRoomSuccess" | "copyLogsSuccess",
  number
>();
