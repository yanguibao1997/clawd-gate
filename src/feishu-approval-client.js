"use strict";

const crypto = require("crypto");

const ACTION_ROW_SIZE = 3;

function loadLarkSdk() {
  try {
    return require("@larksuiteoapi/node-sdk");
  } catch (err) {
    const next = new Error("Missing @larksuiteoapi/node-sdk. Run npm install first.");
    next.cause = err;
    throw next;
  }
}

function normalizeApprovalPayload(payload) {
  const title = String((payload && payload.title) || "").trim();
  if (!title) throw new Error("Feishu approval payload title is required");
  const detail = payload && payload.detail != null ? String(payload.detail) : "";
  const suggestions = Array.isArray(payload && payload.suggestions)
    ? payload.suggestions
      .map((entry) => {
        if (!entry || typeof entry !== "object") return null;
        const index = Number(entry.index);
        const label = String(entry.label || "").trim();
        if (!Number.isInteger(index) || index < 0 || !label) return null;
        return { index, label };
      })
      .filter(Boolean)
    : [];
  return {
    title,
    detail,
    agentId: String((payload && payload.agentId) || "").trim(),
    toolName: String((payload && payload.toolName) || "").trim(),
    folder: String((payload && payload.folder) || "").trim(),
    summary: String((payload && payload.summary) || "").trim(),
    suggestions,
  };
}

function button(text, value, type) {
  return {
    tag: "button",
    text: { tag: "plain_text", content: text },
    type,
    value,
  };
}

function isValidDecisionValue(value) {
  return value === "allow"
    || value === "deny"
    || value === "terminal"
    || /^suggestion:\d+$/.test(String(value || ""));
}

function buildActionRows(actions) {
  const rows = [];
  for (let i = 0; i < actions.length; i += ACTION_ROW_SIZE) {
    rows.push({ tag: "action", actions: actions.slice(i, i + ACTION_ROW_SIZE) });
  }
  return rows;
}

function buildApprovalDetail(normalized) {
  if (normalized.agentId || normalized.toolName || normalized.folder || normalized.summary) {
    return [
      normalized.agentId ? `**智能体**：${normalized.agentId}` : null,
      normalized.toolName ? `**工具**：${normalized.toolName}` : null,
      normalized.folder ? `**目录**：${normalized.folder}` : null,
      normalized.summary ? `**摘要**：${normalized.summary}` : null,
    ].filter(Boolean).join("\n");
  }
  return normalized.detail || normalized.title;
}

function normalizeStatusOutcome(outcome) {
  const raw = outcome && typeof outcome === "object" ? outcome : { decision: outcome };
  const decision = String(raw.decision || raw.behavior || "").trim();
  const actionLabel = String(raw.actionLabel || raw.message || "").trim();
  const source = String(raw.source || "").trim();
  const isSuggestion = /^suggestion:\d+$/.test(decision);

  if (decision === "deny") {
    return {
      decision,
      template: "red",
      title: "已拒绝",
      result: actionLabel || "拒绝",
      source,
    };
  }
  if (decision === "terminal") {
    return {
      decision,
      template: "blue",
      title: "已转到终端处理",
      result: actionLabel || "前往终端处理",
      source,
    };
  }
  if (decision === "no-decision") {
    return {
      decision,
      template: "blue",
      title: "已取消",
      result: actionLabel || "未返回审批结果",
      source,
    };
  }
  if (isSuggestion) {
    return {
      decision,
      template: "green",
      title: "已批准并更新权限",
      result: actionLabel || "已应用权限建议",
      source,
    };
  }
  return {
    decision: "allow",
    template: "green",
    title: "已批准",
    result: actionLabel || "批准一次",
    source,
  };
}

function sourceLabel(source) {
  if (source === "desktop") return "桌面弹窗";
  if (source === "feishu") return "飞书卡片";
  if (source === "remote") return "远程审批";
  return "";
}

function buildApprovalCard(payload, options = {}) {
  const normalized = normalizeApprovalPayload(payload);
  const requestId = String(options.requestId || "");
  const actions = [
    button("批准一次", { requestId, decision: "allow" }, "primary"),
    button("拒绝", { requestId, decision: "deny" }, "danger"),
    button("前往终端", { requestId, decision: "terminal" }, "default"),
    ...normalized.suggestions.map((entry) => (
      button(entry.label, { requestId, decision: `suggestion:${entry.index}` }, "default")
    )),
  ];
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: "orange",
      title: { tag: "plain_text", content: `权限确认：${normalized.agentId || normalized.title}` },
    },
    elements: [
      {
        tag: "div",
        text: { tag: "lark_md", content: buildApprovalDetail(normalized) },
      },
      ...buildActionRows(actions),
    ],
  };
}

function buildStatusCard(payload, outcome) {
  const normalized = normalizeApprovalPayload(payload);
  const status = normalizeStatusOutcome(outcome);
  const source = sourceLabel(status.source);
  const detail = [
    buildApprovalDetail(normalized),
    "",
    `**处理结果**：${status.result}`,
    source ? `**处理来源**：${source}` : null,
  ].filter((line) => line !== null).join("\n");
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: status.template,
      title: { tag: "plain_text", content: status.title },
    },
    elements: [
      {
        tag: "div",
        text: { tag: "lark_md", content: detail },
      },
    ],
  };
}

function parseMaybeJsonObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeActionEvent(event, idType = "open_id") {
  const source = event && typeof event === "object" ? event : {};
  const operator = source.operator && typeof source.operator === "object" ? source.operator : {};
  const action = source.action && typeof source.action === "object" ? source.action : {};
  const value = parseMaybeJsonObject(action.value);
  if (!value) return null;
  const requestId = typeof value.requestId === "string" ? value.requestId : "";
  const decision = isValidDecisionValue(value.decision) ? String(value.decision) : "";
  if (!requestId || !decision) return null;
  const aliases = idType === "user_id"
    ? ["user_id", "userId"]
    : idType === "union_id"
      ? ["union_id", "unionId"]
      : ["open_id", "openId"];
  let operatorId = "";
  for (const key of aliases) {
    if (typeof operator[key] === "string" && operator[key]) {
      operatorId = operator[key];
      break;
    }
    if (typeof source[key] === "string" && source[key]) {
      operatorId = source[key];
      break;
    }
  }
  return { operatorId, requestId, decision };
}

function normalizeApiMessageId(response) {
  return response && response.data && typeof response.data.message_id === "string"
    ? response.data.message_id
    : "";
}

function createLarkClient(config = {}) {
  const lark = config.lark || loadLarkSdk();
  return new lark.Client({
    appId: config.appId,
    appSecret: config.appSecret,
    appType: lark.AppType ? lark.AppType.SelfBuild : undefined,
    domain: lark.Domain ? lark.Domain.Feishu : undefined,
    loggerLevel: lark.LoggerLevel ? lark.LoggerLevel.warn : undefined,
  });
}

function createWsClient(config = {}) {
  const lark = config.lark || loadLarkSdk();
  const dispatcher = new lark.EventDispatcher({
    verificationToken: config.verificationToken || "",
    encryptKey: config.encryptKey || "",
    loggerLevel: lark.LoggerLevel ? lark.LoggerLevel.warn : undefined,
  }).register({
    "card.action.trigger": async (event) => {
      if (typeof config.onCardAction === "function") await config.onCardAction(event);
      return undefined;
    },
  });
  const wsClient = new lark.WSClient({
    appId: config.appId,
    appSecret: config.appSecret,
    loggerLevel: lark.LoggerLevel ? lark.LoggerLevel.warn : undefined,
    autoReconnect: true,
  });
  return { wsClient, dispatcher };
}

class FeishuApprovalClient {
  constructor(options = {}) {
    this.appId = options.appId || "";
    this.appSecret = options.appSecret || "";
    this.verificationToken = options.verificationToken || "";
    this.encryptKey = options.encryptKey || "";
    this.approverId = options.approverId || "";
    this.idType = options.idType || "open_id";
    this.lark = options.lark || null;
    this.larkClient = options.larkClient || null;
    this.wsFactory = options.wsFactory || createWsClient;
    this.wsClient = options.wsClient || null;
    this.dispatcher = options.dispatcher || null;
    this.pending = new Map();
    this.log = typeof options.log === "function" ? options.log : () => {};
  }

  isEnabled() {
    return !!(this.appId && this.appSecret && this.approverId);
  }

  getStatus() {
    const connection = this.wsClient && typeof this.wsClient.getConnectionStatus === "function"
      ? this.wsClient.getConnectionStatus()
      : { state: this.wsClient ? "connected" : "stopped" };
    return {
      status: this.isEnabled() ? (this.wsClient ? "running" : "ready") : "stopped",
      connection,
    };
  }

  async start() {
    if (!this.isEnabled() || this.wsClient) return false;
    const created = this.wsFactory({
      appId: this.appId,
      appSecret: this.appSecret,
      verificationToken: this.verificationToken || "",
      encryptKey: this.encryptKey || "",
      lark: this.lark,
      onCardAction: (event) => this.handleCardAction(event),
    });
    this.wsClient = created.wsClient;
    this.dispatcher = created.dispatcher;
    if (this.wsClient && typeof this.wsClient.start === "function") {
      await this.wsClient.start({ eventDispatcher: this.dispatcher });
    }
    return true;
  }

  close() {
    if (this.wsClient && typeof this.wsClient.close === "function") {
      try { this.wsClient.close(); } catch {}
    }
    this.wsClient = null;
    this.dispatcher = null;
    for (const entry of this.pending.values()) {
      entry.resolve(null);
    }
    this.pending.clear();
  }

  messageApi() {
    const client = this.larkClient || (this.larkClient = createLarkClient({
      appId: this.appId,
      appSecret: this.appSecret,
      lark: this.lark,
    }));
    return client && client.im && client.im.v1 && client.im.v1.message
      ? client.im.v1.message
      : client && client.im && client.im.message;
  }

  requestApproval(payload, options = {}) {
    let normalized;
    try {
      normalized = normalizeApprovalPayload(payload);
    } catch {
      return Promise.resolve(null);
    }
    if (!this.isEnabled()) return Promise.resolve(null);
    const requestId = `fs_${crypto.randomBytes(12).toString("hex")}`;
    const signal = options.signal;
    if (signal && signal.aborted) return Promise.resolve(null);

    return new Promise((resolve) => {
      let settled = false;
      const finish = (decision) => {
        if (settled) return;
        settled = true;
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
        this.pending.delete(requestId);
        resolve(isValidDecisionValue(decision) ? decision : null);
      };
      const onAbort = () => finish(null);
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      const entry = {
        payload: normalized,
        messageId: "",
        signal: signal || null,
        resolve: finish,
        sendReady: null,
      };
      this.pending.set(requestId, entry);
      entry.sendReady = this.sendCard(requestId, normalized)
        .then((messageId) => {
          entry.messageId = messageId || "";
          const current = this.pending.get(requestId);
          if (current) current.messageId = messageId || "";
          return current || entry;
        })
        .catch((err) => {
          this.log("warn", "send failed", { error: err && err.message ? err.message : String(err) });
          finish(null);
          return entry;
        });
    });
  }

  async sendCard(requestId, payload) {
    const message = this.messageApi();
    if (!message || typeof message.create !== "function") throw new Error("Feishu message.create is unavailable");
    const response = await message.create({
      params: { receive_id_type: this.idType || "open_id" },
      data: {
        receive_id: this.approverId,
        msg_type: "interactive",
        content: JSON.stringify(buildApprovalCard(payload, { requestId })),
      },
    });
    return normalizeApiMessageId(response);
  }

  async updateCard(messageId, payload, outcome) {
    if (!messageId) return;
    const message = this.messageApi();
    if (!message || typeof message.patch !== "function") return;
    await message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(buildStatusCard(payload, outcome)) },
    });
  }

  findPendingBySignal(signal) {
    if (!signal) return null;
    for (const [requestId, entry] of this.pending.entries()) {
      if (entry && entry.signal === signal) return { requestId, entry };
    }
    return null;
  }

  resolveApprovalExternally(signal, outcome = {}) {
    const found = this.findPendingBySignal(signal);
    if (!found) return false;
    const { entry } = found;
    Promise.resolve(entry.sendReady)
      .then(() => this.updateCard(entry.messageId, entry.payload, {
        ...outcome,
        source: outcome.source || "desktop",
      }))
      .catch((err) => {
        this.log("warn", "external update failed", { error: err && err.message ? err.message : String(err) });
      })
      .finally(() => entry.resolve(null));
    return true;
  }

  handleCardAction(event) {
    const action = normalizeActionEvent(event, this.idType);
    if (!action || action.operatorId !== this.approverId) return false;
    const entry = this.pending.get(action.requestId);
    if (!entry) return false;
    Promise.resolve(entry.sendReady)
      .then(() => this.updateCard(entry.messageId, entry.payload, {
        decision: action.decision,
        source: "feishu",
      }))
      .catch((err) => {
        this.log("warn", "update failed", { error: err && err.message ? err.message : String(err) });
      })
      .finally(() => entry.resolve(action.decision));
    return true;
  }
}

module.exports = {
  FeishuApprovalClient,
  buildApprovalCard,
  buildStatusCard,
  normalizeApprovalPayload,
  normalizeActionEvent,
  createLarkClient,
  createWsClient,
};
