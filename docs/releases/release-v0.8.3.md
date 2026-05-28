## v0.8.3

### New Features

- **Feishu remote approval** - Added an opt-in Feishu approval channel alongside Telegram remote approval. When configured, actionable local permission bubbles can also send interactive Feishu approval cards so permission requests can be handled away from the desktop.
- **Feishu approval cards** - Feishu cards support allow, deny, terminal handoff, and agent-provided permission suggestions. Card status is updated after either a Feishu decision or a local desktop decision so the remote view does not stay stale.
- **Feishu elicitation flow** - Claude Code elicitation-style questions can be answered through Feishu cards, including multi-step question navigation, option selection, free-form answers, and final submission back to the local permission flow.
- **Feishu Settings channel** - The Remote Approval settings tab now includes a Feishu channel with app credential storage, approver id configuration, id type selection, readiness/status display, enable/disable controls, and a test card action.

### Bug Fixes

- **Remote approval summaries** - Refined permission summary generation for remote approval cards so tool, agent, folder, and request details are easier to inspect before deciding.
- **Remote approval lifecycle** - Remote clients now share a common approval path that can abort in-flight remote requests when the local bubble resolves first, handle terminal handoff consistently, and keep unsupported or unavailable remote channels from blocking the local approval path.
- **Feishu secret handling** - Feishu App ID, App Secret, Verification Token, and Encrypt Key are stored outside `clawd-prefs.json`, masked in Settings, written atomically, and redacted from runtime output.
- **Settings renderer hardening** - Remote approval UI rendering and browser-environment tests were expanded so Telegram and Feishu controls can coexist without stale status or command wiring regressions.

### Upgrade Notes

- Feishu approval is disabled by default. To use it, configure a Feishu self-built app, save the App ID / App Secret in Settings, set the approver id (`open_id`, `user_id`, or `union_id`), then enable Feishu approval from the Remote Approval tab.
- Feishu credentials are stored in the user-data env file rather than in `clawd-prefs.json`. Existing Telegram approval settings are not migrated or changed.
- The app now depends on `@larksuiteoapi/node-sdk` for Feishu support. Run `npm install` after pulling source changes before launching or building from source.
- Release metadata is bumped to `0.8.3` in both `package.json` and `package-lock.json`.

### Docs & Contributors

- About-page author and repository copy were refreshed.
- Release notes are prepared for the tag-gated draft GitHub Release workflow.

### Known Limitations

- Feishu approval requires a reachable Feishu bot / self-built app configuration and successful long-connection callbacks. If Feishu is unavailable, local desktop permission bubbles remain the primary approval surface.
- Feishu and Telegram remote approval are opt-in helper channels. They do not replace agent-native fallback prompts when Clawd is offline, DND suppresses bubbles, or a request is intentionally unsupported for remote approval.
- macOS / Linux real-machine QA remains best-effort. CI can build artifacts, but Windows remains the primary hands-on validation environment.
