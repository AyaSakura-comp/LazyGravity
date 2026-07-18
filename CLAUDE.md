# LazyGravity — 本機部署架構與運維指南

LazyGravity(bot `Ado#4549`)= 用 Discord 遙控本機 **Antigravity IDE**(Google 的
Gemini agent IDE,VS Code fork)的橋接器。手機上 @tag 或 DM bot → 它把話塞進
Antigravity 的 agent 聊天面板 → 把 IDE 的回應抓回來貼到 Discord。upstream 是
`tokyoweb3/LazyGravity`,這份 clone 帶大量本機客製(見 git log 與下方)。

> 通用架構文件在 `docs/ARCHITECTURE.md`(platform 抽象層、Telegram 支援等)。
> 本檔是**這台機器的實際部署**:誰在跑、怎麼重啟、怎麼測、踩過哪些坑。

---

## 架構(這台機器上的實際拓樸)

```
📱 Discord (@Ado tag / DM / thread)
        │ WebSocket (discord.js)
        ▼
lazygravity-bot.service ──── SQLite antigravity.db(綁定/session/偏好)
        │ CDP (ws://127.0.0.1:9223)
        ▼
lazygravity-antigravity.service = Antigravity IDE(Electron,headless)
        │ 畫在 Xvfb :99(openclaw-xvfb.service)
        │ agent 面板 = Gemini(模型如 Gemini 3.5 Flash (High))
        ▼
~/src 下的專案(WORKSPACE_BASE_DIR)

旁路:lazygravity-autoapprove.service(獨立 CDP watcher,自動點「Always Allow」)
```

四個 systemd **user** unit 由 **`lazygravity.target`** 綁在一起(開機自啟):

| Unit | 角色 | 關鍵細節 |
|---|---|---|
| `openclaw-xvfb.service` | 無頭 X display **:99** | 跟 OpenClaw 共用 |
| `lazygravity-antigravity.service` | Antigravity IDE,CDP **9223** | ⚠️ 直接跑 Electron 二進位 `/usr/share/antigravity/antigravity`(CLI wrapper 會 detach);⚠️ 必須強制 X11(`--ozone-platform=x11` + `XDG_SESSION_TYPE=x11`,否則撿到 Wayland 直接 SEGV);`ExecStartPost` 輪詢 CDP 到通才算 started |
| `lazygravity-bot.service` | 本體(`dist/bin/cli.js start`) | `DISPLAY=:99`,`After=` antigravity |
| `lazygravity-autoapprove.service` | `~/models-work/lazygravity/autoapprove_daemon.js` | 每 2s 掃所有 CDP context,自動點瀏覽器權限的「Always Allow」 |

- CDP **9222 是 Hermes 的 Chrome,不要碰**;Antigravity 固定 9223(`.env` 的 `ANTIGRAVITY_ACCOUNTS=default:9223`)。

## 工作流程(一則訊息的生命週期)

1. **收訊 + 權限**(`src/events/messageCreateHandler.ts`):
   - `isUserAllowed()`(`src/utils/access.ts`)查 `ALLOWED_USER_IDS` 白名單;**目前設 `*` = 對所有人開放**(還原:改回你的 id + rebuild + 重啟 bot)。
   - **互動規則**:伺服器頻道要 **@tag** 才理;**thread 裡免 tag**;DM 自由對話。tag 前綴會從 prompt 剝掉。
2. **自動開 thread**:一般頻道 @tag → `message.startThread()` 開一個 thread、把 `channelId` 重新指過去 → **每個 thread = 獨立 section**。
3. **Thread session**(`workspaceCommandHandler.ensureThreadSession`):thread 第一次有訊息時建立自己的 session row(繼承母頻道 workspace)→ 路由層對它 `startNewChat`(全新 IDE 對話);舊 thread 靠 `displayName` 用 `activateSessionByTitle` 切回自己原本的對話。**thread ↔ conversation 一對一**。
4. **Workspace 解析**:`getWorkspaceForChannel(channelId, parentChannelId)` — 自己的綁定 → session → **母頻道綁定(thread 繼承)** → 都沒有就 `ensureDefaultBinding` 綁 `.`(= `WORKSPACE_BASE_DIR` = **~/src**,刻意不綁特定 project)。
5. **送進 IDE**(`bot/index.ts::sendPromptToAntigravity` → `cdpService.injectMessage`):per-workspace queue 序列化;CDP 把文字塞進 agent 輸入框、按 Enter(有 `ensureSubmitted` 防掉字)。
6. **抓回應**(`ResponseMonitor` / `assistantDomExtractor`):輪詢 agent 面板 DOM 做結構化擷取,回應以 embed/純文字貼回 Discord(該 thread/頻道)。**360s safety timeout** 防佇列死鎖。
7. **旁路偵測器**:approval/error-popup/planning/run-command detector 在訊息處理期間輪詢;autoapprove daemon 則常駐。

## 每個 component 在幹嘛(src/)

- `events/messageCreateHandler.ts` — 訊息入口:白名單、tag/thread gate、自動開 thread、thread session、workspace 路由、送 IDE、等回應。
- `events/interactionCreateHandler.ts` — slash 指令/按鈕/選單入口(同樣走 `isUserAllowed`)。
- `commands/chatCommandHandler.ts` — `/new`(伺服器頻道開新 session 頻道;**thread/DM = 重置自己這條的對話**)、`/chat` 等。
- `commands/workspaceCommandHandler.ts` — 專案綁定、`ensureDefaultBinding`(預設 ~/src)、`ensureThreadSession`。
- `services/cdpService.ts` — 對單一 Antigravity 的 CDP 操作(注入訊息、截圖、DOM eval;`_uiLock` 防止截圖打斷送字)。
- `services/cdpConnectionPool.ts` / `cdpBridgeManager.ts` — 多 workspace/帳號連線池 + 偵測器掛載。
- `services/chatSessionService.ts` — IDE 端對話操作(startNewChat、activateSessionByTitle)。
- `services/quotaService.ts` — 直接打 language_server 的 `GetUserStatus` API 拿各模型配額(`/usage`)。
- `services/autoAcceptService.ts` + `approvalDetector.ts` — 對話內審批自動點擊(`AUTO_APPROVE_FILE_EDITS=true` 目前開著)。
- `database/*.ts` — better-sqlite3 repos(`antigravity.db`):workspace_bindings、chat_sessions(channel_id UNIQUE)、偏好等。
- `utils/access.ts` — 白名單判斷(含 `*` wildcard)。
- `utils/configLoader.ts` — `.env` 載入(`ALLOWED_USER_IDS` 逗號分隔或 `*`)。

## 重啟 / 開啟整個服務

```bash
# 首選:整條鏈重啟 + 驗證(等同 /restart-gemini skill)
bash ~/.hermes/skills/restart-gemini/scripts/restart.sh        # 全部
bash ~/.hermes/skills/restart-gemini/scripts/restart.sh --no-bot  # 只重啟 Xvfb+Antigravity

# 手動等價
systemctl --user restart lazygravity.target    # 四個 unit 全部
systemctl --user restart lazygravity-bot.service   # 只重啟 bot(改了 code / .env 之後)

# 改 code 後
npm run build && systemctl --user restart lazygravity-bot.service
```

**卡住診斷順序**:
1. `systemctl --user is-active openclaw-xvfb lazygravity-antigravity lazygravity-bot lazygravity-autoapprove`
2. `curl -s http://localhost:9223/json/version`(CDP 活著?)
3. `journalctl --user -u lazygravity-bot.service -n 50` — 看 `Safety timeout`(= IDE 端沒吐乾淨回應)、`Structured extraction failed`
4. 基礎設施都正常還卡 → 幾乎都是 **IDE 端 UI 狀態卡住**:待審核的 Accept all/Reject all 檔案變更、擴充套件推薦彈窗、git 警告彈窗。用 CDP 連 9223 的 workbench 頁 `Runtime.evaluate` 讀 `document.body.innerText` 找,把按鈕點掉(或重啟整條鏈)。

## 測試

```bash
npx tsc --noEmit        # 型別檢查(必須 0 error)
npx jest                # 全套;已知 5 個 pre-existing 失敗 suite(bot、cleanupCommandHandler、
                        # configLoader、quotaService、screenshotService)— 改動前後應同一批
# 針對常動的部分
npx jest tests/events/messageCreateHandler.test.ts      # gate/auto-thread/thread-session
npx jest tests/commands/chatCommandHandler.test.ts      # /new(含 thread/DM 分支)
npx jest tests/commands/workspaceCommandHandler.test.ts # workspace 繼承
npx jest tests/utils/access.test.ts                     # 白名單/wildcard
```

端到端 smoke:重啟後在 Discord DM bot 講一句話 → 應該 👀 反應 → IDE 回應貼回;
或 `cd ~/src/LazyGravity && node dist/bin/cli.js doctor`(檢查 CDP 埠)。

## 本機重要設定/慣例

- `.env`(chmod 600,**gitignored**):`ALLOWED_USER_IDS=*`(⚠️ 全開)、`ANTIGRAVITY_ACCOUNTS=default:9223`、`WORKSPACE_BASE_DIR=~/src`、`AUTO_APPROVE_FILE_EDITS=true`、`PLATFORMS=discord`。
- 預設 workspace 刻意是 **~/src 整個目錄**(不綁特定 project)。為了不讓 VS Code 掃遍底下所有 repo,`~/.config/Antigravity/User/settings.json` 設了 `git.autoRepositoryDetection: "openEditors"` + `files.watcherExclude`(venv/node_modules/模型檔)+ `search.followSymlinks: false`;另有 workspace trust 關閉、chat.tools 全 autoApprove。
- Discord slash 指令是**全域註冊**(GUILD_ID 空),改動最多 1 小時才生效。
- 測試 mock 慣例:`buildMessage()` 預設 DM(gate no-op),guild 情境用 `buildGuildMessage({mentioned, thread})`。
