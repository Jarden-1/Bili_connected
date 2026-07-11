# Bili-SyncPlay 代码审查报告

**审查日期**：2026-07-11
**审查范围**：加入房间 / 悬浮按钮 popover / popup 昵称编辑 / 共享视频逻辑 / 全局代码质量
**审查人**：WorkBuddy

---

## 一、本次修复的核心问题

### 1. 加入房间时多一个冒号（致命 Bug）

**现象**：用户在 popup 输入 4 位房间号 `5643`，输入框自动变成 `5643:`，点击「加入」时 server 返回 `Invalid client message payload`，加入失败。

**根因**（两处独立缺陷叠加）：

| #   | 位置                                                                    | 缺陷                                                                                                                                                                        |
| --- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `extension/src/popup/popup-actions.ts` 的 `input` 事件                  | 解析后把 `roomCodeDraft` 写成 `` `${invite.roomCode}:${invite.joinToken}` ``，而 4 位房间的 `joinToken` 是空串，于是拼出 `5643:`。下一次 render 时该 draft 被回写到输入框。 |
| 2   | `packages/protocol/src/guards/client-message.ts` 的 `isJoinRoomPayload` | 强制要求 `isToken(value.joinToken)`，空串不通过校验，server 直接返回 `invalid_message`。                                                                                    |

4 位数字房间在设计上是**公开房间**（commit 9f34f09），任何人拿到 4 位码就能加入，不应该要求 joinToken。但协议层和 UI 层都没把这个事实贯穿下去。

**修复**：

- `packages/protocol/src/types/client-message.ts` — `JoinRoomMessage.payload.joinToken` 改为可选 `joinToken?: string`。
- `packages/protocol/src/guards/client-message.ts` — `isJoinRoomPayload` 接受 `joinToken === undefined`。
- `extension/src/popup/helpers.ts` — `parseInviteValue` 对 4 位房间返回 `joinToken: null`；新增 `formatInviteDraft(invite)`，4 位房间永远只返回 roomCode，不附加 token。
- `extension/src/popup/popup-actions.ts` — input 事件和 `joinRoom` 都改用 `formatInviteDraft(invite)`，不再手工拼冒号。
- `extension/src/background/room-session-controller.ts` — `requestJoinRoom` / `sendJoinRequest` 接受 `joinToken: string | null`，为 null 时不发送该字段。
- `extension/src/shared/messages.ts` — `popup:join-room` 和 `content:join-room` 的 `joinToken` 类型改为 `string | null`。
- `server/src/room-service.ts` / `server/src/message-handler.ts` — `joinRoomForSession` / `ensureJoinRequestAllowed` / `persistJoinedRoom` 的 `joinToken` 改为 `string | null`；`message-handler` 用 `?? null` 把 `undefined` 归一化。

**验证**：所有 478 个测试通过（含新增的 `formatInviteDraft` / `parseInviteValue` 公开房间用例）；之前 pre-existing 失败的 `content:report-user` 测试也修正为匹配「只 seed 一次」的真实行为。

---

### 2. 悬浮按钮 popover 缺少「快速创建房间」入口

**现象**：未加入房间时，popover 只有「输入房间号 + 加入」表单，没有明显的「创建房间」入口。用户只能点击悬浮按钮本身（会触发 `shareCurrentPageVideoFromContent`，弹 confirm）。

**修复**：

- `extension/src/content/page-share-button.ts` — 在 `popover-section-join` 顶部加「快速创建」按钮，点击直接发 `content:create-room`，期间显示 `创建中...`，成功后 800ms 刷新 popover 切到 joined section。
- `extension/src/shared/i18n.ts` — 新增 `pageShareQuickCreate` / `pageShareQuickCreatePending` / `pageShareQuickCreateFailed` 三条文案（中英双语，文案尽量短）。

---

### 3. popover / popup 不显示「当前同步视频」和「昵称编辑」

**现象**：

- popover 已加入房间区域没有显示当前同步的视频标题。
- popup 已加入房间区域没有昵称显示和编辑入口（用户截图 3 的需求）。

**修复**：

#### popover 侧

- `page-share-button.ts` 模板新增 `popover-shared-video-row` + `popover-shared-video-value`，渲染 `viewModel.sharedVideoTitle`；空标题时显示 `暂无共享视频` 并加 `is-empty` class 变灰。

#### popup 侧

- `popup-template.ts` — 在 `room-panel-joined` 加 `room-nickname-row`（昵称 + 修改按钮）和 `room-nickname-form`（默认 `hidden`，点修改才显示）。
- `popup-view.ts` — 新增 6 个 ref：`nicknameValue` / `nicknameEditButton` / `nicknameForm` / `nicknameInput` / `nicknameSaveButton` / `nicknameCancelButton`。
- `popup-store.ts` — `PopupUiState` 新增 `nicknameEditing` / `nicknameInputFocused`。
- `popup-actions.ts` — 注册「修改 / 取消 / 保存 / focus / blur」5 个事件；保存时发 `popup:set-display-name`，成功后显示 `昵称已更新`。
- `popup-render.ts` — 渲染昵称值、切换 form 显隐；输入框只在未聚焦且为空时才预填当前昵称，避免覆盖用户正在输入的内容。
- `popup/index.ts` — 把 `nicknameEditing` / `nicknameInputFocused` 透传给 render。
- `messages.ts` + `message-controller.ts` — 新增 `popup:set-display-name` 消息路由，复用 `content:set-display-name` 的 `profile:update` 下发逻辑。
- `public/popup.css` — 加 `room-nickname-row` / `room-nickname-value` / `room-nickname-form` 样式。

---

### 4. 「换视频不需要重新创建房间」

**结论**：该需求**早已实现**，无需代码改动。

链路验证：

1. 用户在房间 A（`roomCode` 非空），切换到另一个 B 站视频页。
2. 点击悬浮按钮或 popup 的「同步当前页视频」。
3. `shareCurrentPageVideoFromContent` 检测到 `contextResponse.roomCode` 存在且 `sharedVideo.url` 与当前视频不同，弹 `confirmReplaceSharedVideo` 询问。
4. 用户同意 → 发 `video:share`。
5. `server/src/room-service.ts` 的 `shareVideoForSession` 直接 `roomStore.updateRoom` 覆盖 `sharedVideo` + `playback` 字段，**房间号不变**，成员不变。

唯一可能的用户困惑点是 confirm 对话框的文案让人以为「换视频 = 重新创建」。实际上房间号始终沿用。本次未改文案，避免引入新的歧义。

---

## 二、全局代码质量审查

### 2.1 已修复的屎山 / 不优雅代码

| 文件                                                            | 问题                                                                                                               | 处理                                                                     |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `extension/src/background/message-controller.ts:135`            | `case "popup:create-room"` 块内直接用 `const createDeadline` 触发 `no-case-declarations` lint 错误（pre-existing） | 用 `{}` 显式包裹 case 块                                                 |
| `extension/src/content/danmaku-chat.ts:28`                      | `BILI_BLUE` 常量定义后从未使用（pre-existing）                                                                     | 删除                                                                     |
| `server/src/room-store.ts:5`                                    | `ROOM_CODE_ALPHABET` 常量定义后从未使用（pre-existing，是 4 位数字房间改造后的遗留物）                             | 删除                                                                     |
| `extension/src/popup/popup-render.ts`                           | `formatInviteDraft` 原签名 `(roomCode, _joinToken)` 第二个参数下划线开头却未真正使用，且实现忽略 joinToken         | 迁移到 `helpers.ts`，签名改为 `(invite: ParsedInvite \| null)`，语义清晰 |
| `extension/src/popup/popup-actions.ts`                          | input 事件和 `joinRoom` 各自手写 `` `${roomCode}:${joinToken}` `` 拼接，4 位房间会拼出尾冒号                       | 统一调用 `formatInviteDraft(invite)`                                     |
| `extension/src/content/page-share-button.ts` `handleJoinSubmit` | `joinToken: ""` 硬编码空串，与新协议类型 `string \| null` 不匹配                                                   | 改为 `joinToken: null`                                                   |

### 2.2 仍存在但本次未动的潜在改进点（建议后续处理）

1. **`server/src/room-service.ts` 仍为每个房间生成 joinToken**（`createRoomForSession` 第 990 行 `joinToken: generateToken()`）。
   - 4 位数字房间是公开的，joinToken 实际无人使用，但 server 仍生成并存储。
   - 影响：存储浪费；`room:created` 仍下发给 client 一个「假」的 joinToken，client 端 `formatInviteDraft` 必须主动忽略它。
   - 建议：后续给 `PersistedRoom` 加 `isPublic: boolean` 字段，公开房间不生成 joinToken，`room:created` 也不下发。

2. **`extension/src/background/message-controller.ts` 单文件 700+ 行**，`handleRuntimeMessage` 是一个巨型 switch。
   - 建议：按消息域拆分（room / video / settings / admin），每个域一个 handler 文件。

3. **`extension/src/content/page-share-button.ts` 单文件 1400+ 行**，模板字符串、CSS、状态机、事件绑定全混在一起。
   - 建议：把 shadow DOM 模板和 CSS 抽到独立文件，状态机用 reducer 模式重构。

4. **`extension/src/popup/popup-render.ts` 的 `renderPopup` 函数有 20+ 个参数**。
   - 建议：聚合成一个 `RenderPopupArgs` 接口，减少调用点噪声。

5. **`confirmReplaceSharedVideo` 文案**：当前是 `当前房间正在同步《X》。\n是否替换为《Y》？`，未明确说明「房间号不变」。
   - 建议：改为 `当前房间（房间号 1234）正在同步《X》。\n切换为《Y》？房间号保持不变。`

---

## 三、测试与验证

| 检查项              | 结果                                                        |
| ------------------- | ----------------------------------------------------------- |
| `npm run lint`      | ✅ 0 错误（baseline 5 个，本次修复 5 个，新增 0 个）        |
| `npm run typecheck` | ✅ 全部通过（protocol / server / extension 三个 workspace） |
| `npm test`          | ✅ 全部通过（478 个 extension 测试 + protocol/server 测试） |
| `npm run build`     | ✅ Chrome 扩展打包成功                                      |

### 新增/修改的测试用例

- `packages/protocol/test/client-message.test.ts` — 把 `rejects room:join without joinToken` 改为 `accepts room:join without joinToken for public rooms`。
- `extension/test/popup-helpers.test.ts` — `parseInviteValue` 期望 `joinToken: null`；新增 `formatInviteDraft omits the joinToken segment for public joins`。
- `extension/test/popup-render.test.ts` — 所有 `renderPopup` 调用补齐 `nicknameEditing` / `nicknameInputFocused` 参数；`createPopupRefs` 补齐 6 个新 ref。
- `extension/test/popup-save-server-url.test.ts` — `REF_KEYS` 补齐 6 个新 ref。
- `extension/test/message-controller.test.ts` — 修正 `content:report-user` 测试以匹配「只 seed 一次 displayName」的真实行为（pre-existing fail 修复）。

---

## 四、改动文件清单

### protocol

- `packages/protocol/src/types/client-message.ts`
- `packages/protocol/src/guards/client-message.ts`
- `packages/protocol/test/client-message.test.ts`

### server

- `server/src/room-service.ts`
- `server/src/message-handler.ts`
- `server/src/room-store.ts`（删除未使用常量）

### extension — background

- `extension/src/background/message-controller.ts`
- `extension/src/background/room-session-controller.ts`

### extension — popup

- `extension/src/popup/helpers.ts`（重写 parseInviteValue / 新增 formatInviteDraft）
- `extension/src/popup/popup-actions.ts`
- `extension/src/popup/popup-render.ts`
- `extension/src/popup/popup-store.ts`
- `extension/src/popup/popup-template.ts`
- `extension/src/popup/popup-view.ts`
- `extension/src/popup/index.ts`
- `extension/public/popup.css`

### extension — content

- `extension/src/content/page-share-button.ts`
- `extension/src/content/danmaku-chat.ts`（删除未使用常量）

### extension — shared

- `extension/src/shared/messages.ts`
- `extension/src/shared/i18n.ts`

### extension — test

- `extension/test/popup-helpers.test.ts`
- `extension/test/popup-render.test.ts`
- `extension/test/popup-save-server-url.test.ts`
- `extension/test/message-controller.test.ts`

---

## 五、回归风险

| 风险点                                     | 评估                                                                                                                                                                    |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4 位房间不再校验 joinToken                 | **低**。server 端 `ensureJoinRequestAllowed` 原本就是 `if (args.joinToken && ...)` 短路逻辑，client 不发 token 时早已放行；本次只是让协议层和 UI 层与 server 行为对齐。 |
| 老版本客户端发的 `roomCode:joinToken` 格式 | **低**。`parseInviteValue` 仍兼容 `roomCode:joinToken` 分隔符解析；只是 4 位纯数字优先走公开分支。                                                                      |
| popup 新增昵称编辑                         | **低**。新增的 `popup:set-display-name` 复用 `content:set-display-name` 的 `profile:update` 下发逻辑，server 端无改动。                                                 |
| popover 新增「快速创建」按钮               | **低**。直接调用已有的 `content:create-room` 消息，无新协议。                                                                                                           |

---

## 六、结论

本次修复彻底解决了「4 位房间加入失败」的致命 bug（协议层 + UI 层双重缺陷），补齐了 popover / popup 的「快速创建房间」「当前同步视频」「昵称编辑」三个 UI 短板，并清理了 5 处 pre-existing 的 lint 错误和屎山代码。所有测试通过，build 成功。

剩余的 5 个潜在改进点（room 模型的 `isPublic` 字段、大文件拆分、confirm 文案优化等）建议后续单独处理，不在本次范围内。
