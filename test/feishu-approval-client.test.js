"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  FeishuApprovalClient,
  buildApprovalCard,
  normalizeApprovalPayload,
  normalizeActionEvent,
} = require("../src/feishu-approval-client");

test("buildApprovalCard creates an interactive allow deny card", () => {
  const card = buildApprovalCard({
    title: "claude-code requests Bash",
    agentId: "claude-code",
    toolName: "Bash",
    folder: "project-alpha",
    summary: "Run tests",
    suggestions: [{ index: 0, label: "自动接受编辑" }],
  }, { requestId: "req_1" });
  assert.equal(card.config.update_multi, true);
  assert.equal(card.header.title.content, "权限确认：claude-code");
  assert.match(card.elements[0].text.content, /智能体/);
  assert.match(card.elements[0].text.content, /摘要/);
  const action = card.elements.find((element) => element.tag === "action");
  assert.equal(action.actions.length, 3);
  assert.equal(action.actions[0].text.content, "批准一次");
  assert.equal(action.actions[1].text.content, "拒绝");
  assert.equal(action.actions[2].text.content, "前往终端");
  assert.deepEqual(action.actions[0].value, { requestId: "req_1", decision: "allow" });
  assert.deepEqual(action.actions[1].value, { requestId: "req_1", decision: "deny" });
  const secondAction = card.elements.filter((element) => element.tag === "action")[1];
  assert.equal(secondAction.actions[0].text.content, "自动接受编辑");
  assert.deepEqual(secondAction.actions[0].value, { requestId: "req_1", decision: "suggestion:0" });
});

test("FeishuApprovalClient sends a card and resolves from card action", async () => {
  const sent = [];
  const updated = [];
  const fakeClient = {
    im: { v1: { message: {
      create: async (payload) => {
        sent.push(payload);
        return { data: { message_id: "om_1" } };
      },
      patch: async (payload) => {
        updated.push(payload);
        return { data: {} };
      },
    } } },
  };
  const client = new FeishuApprovalClient({
    appId: "cli_123",
    appSecret: "secret",
    approverId: "ou_1",
    idType: "open_id",
    larkClient: fakeClient,
  });

  const decisionPromise = client.requestApproval({ title: "Run", detail: "Summary: Run tests" });
  await Promise.resolve();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].params.receive_id_type, "open_id");
  assert.equal(sent[0].data.receive_id, "ou_1");
  assert.equal(sent[0].data.msg_type, "interactive");
  const requestId = JSON.parse(sent[0].data.content).elements[1].actions[0].value.requestId;
  assert.equal(client.handleCardAction({
    operator: { open_id: "ou_1" },
    action: { value: { requestId, decision: "allow" } },
  }), true);

  assert.equal(await decisionPromise, "allow");
  assert.equal(updated.length, 1);
  assert.equal(updated[0].path.message_id, "om_1");
  assert.match(JSON.parse(updated[0].data.content).header.title.content, /已批准/);
});

test("FeishuApprovalClient resolves terminal action and external desktop updates card", async () => {
  const sent = [];
  const updated = [];
  const fakeClient = {
    im: { v1: { message: {
      create: async (payload) => {
        sent.push(payload);
        return { data: { message_id: "om_1" } };
      },
      patch: async (payload) => {
        updated.push(payload);
        return { data: {} };
      },
    } } },
  };
  const client = new FeishuApprovalClient({
    appId: "cli_123",
    appSecret: "secret",
    approverId: "ou_1",
    idType: "open_id",
    larkClient: fakeClient,
  });
  const ac = new AbortController();

  const decisionPromise = client.requestApproval(
    { title: "Run", detail: "Summary: Run tests" },
    { signal: ac.signal }
  );
  await Promise.resolve();
  const requestId = JSON.parse(sent[0].data.content).elements[1].actions[2].value.requestId;
  assert.equal(client.handleCardAction({
    operator: { open_id: "ou_1" },
    action: { value: { requestId, decision: "terminal" } },
  }), true);
  assert.equal(await decisionPromise, "terminal");
  assert.match(JSON.parse(updated[0].data.content).header.title.content, /已转到终端处理/);

  const ac2 = new AbortController();
  const secondPromise = client.requestApproval(
    { title: "Run", detail: "Summary: Run tests" },
    { signal: ac2.signal }
  );
  await Promise.resolve();
  assert.equal(client.resolveApprovalExternally(ac2.signal, {
    decision: "deny",
    actionLabel: "拒绝",
    source: "desktop",
  }), true);
  assert.equal(await secondPromise, null);
  assert.match(JSON.parse(updated[1].data.content).header.title.content, /已拒绝/);
  assert.match(JSON.parse(updated[1].data.content).elements[0].text.content, /桌面弹窗/);
});

test("FeishuApprovalClient can update card after local decision before send resolves", async () => {
  let resolveCreate;
  const updated = [];
  const fakeClient = {
    im: { v1: { message: {
      create: async () => new Promise((resolve) => { resolveCreate = resolve; }),
      patch: async (payload) => {
        updated.push(payload);
        return { data: {} };
      },
    } } },
  };
  const client = new FeishuApprovalClient({
    appId: "cli_123",
    appSecret: "secret",
    approverId: "ou_1",
    idType: "open_id",
    larkClient: fakeClient,
  });
  const ac = new AbortController();
  const decisionPromise = client.requestApproval(
    { title: "Run", detail: "Summary: Run tests" },
    { signal: ac.signal }
  );

  await Promise.resolve();
  assert.equal(client.resolveApprovalExternally(ac.signal, {
    decision: "allow",
    actionLabel: "批准一次",
    source: "desktop",
  }), true);
  resolveCreate({ data: { message_id: "om_late" } });

  assert.equal(await decisionPromise, null);
  assert.equal(updated.length, 1);
  assert.equal(updated[0].path.message_id, "om_late");
  assert.match(JSON.parse(updated[0].data.content).elements[0].text.content, /桌面弹窗/);
});

test("FeishuApprovalClient ignores non-approver actions and aborts pending request", async () => {
  const fakeClient = {
    im: { v1: { message: {
      create: async () => ({ data: { message_id: "om_1" } }),
      patch: async () => ({ data: {} }),
    } } },
  };
  const client = new FeishuApprovalClient({
    appId: "cli_123",
    appSecret: "secret",
    approverId: "ou_1",
    idType: "open_id",
    larkClient: fakeClient,
  });
  const ac = new AbortController();
  const promise = client.requestApproval({ title: "Run", detail: "Summary" }, { signal: ac.signal });
  await Promise.resolve();
  const requestId = Array.from(client.pending.keys())[0];
  assert.equal(client.handleCardAction({
    operator: { open_id: "ou_other" },
    action: { value: { requestId, decision: "deny" } },
  }), false);
  assert.equal(client.pending.size, 1);
  ac.abort();
  assert.equal(await promise, null);
  assert.equal(client.pending.size, 0);
});

test("pure helpers validate payloads and card action events", () => {
  assert.deepEqual(normalizeApprovalPayload({ title: "  hi ", detail: 42, extra: true }), {
    title: "hi",
    detail: "42",
    agentId: "",
    toolName: "",
    folder: "",
    summary: "",
    suggestions: [],
  });
  assert.throws(() => normalizeApprovalPayload({ title: "" }), /title/);
  assert.deepEqual(normalizeActionEvent({
    operator: { open_id: "ou_1" },
    action: { value: JSON.stringify({ requestId: "req_1", decision: "deny" }) },
  }, "open_id"), {
    operatorId: "ou_1",
    requestId: "req_1",
    decision: "deny",
  });
  assert.deepEqual(normalizeActionEvent({
    operator: { open_id: "ou_1" },
    action: { value: { requestId: "req_1", decision: "suggestion:2" } },
  }, "open_id"), {
    operatorId: "ou_1",
    requestId: "req_1",
    decision: "suggestion:2",
  });
  assert.deepEqual(normalizeActionEvent({
    operator: { open_id: "ou_1" },
    action: { value: { requestId: "req_1", decision: "terminal" } },
  }, "open_id"), {
    operatorId: "ou_1",
    requestId: "req_1",
    decision: "terminal",
  });
  assert.equal(normalizeActionEvent({ action: { value: { requestId: "req_1", decision: "later" } } }, "open_id"), null);
});
