/**
 * task-persistence — OpenClaw plugin
 *
 * Layer 0: On gateway_start, checks for leftover pending-reply.json and sends
 *          a Feishu App API message to the correct chat to trigger recovery.
 * Layer 1: Writes pending-reply.json on before_agent_start, deletes on agent_end.
 * Layer 2: Reads active-task.json on before_agent_start and injects resume context.
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

interface PendingReply {
  channel: string;
  chatId: string;
  sessionKey: string;
  userMessage: string;
  startedAt: string;
}

interface ActiveTask {
  taskId: string;
  description: string;
  steps: Array<{ step: number; label: string; status: string }>;
  currentStep: number;
  startedAt: string;
  updatedAt: string;
}

// ── Feishu App API ──────────────────────────────────────────

interface FeishuConfig {
  appId: string;
  appSecret: string;
}

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getFeishuTenantToken(cfg: FeishuConfig, logger: { info: (m: string) => void; warn: (m: string) => void }): Promise<string | null> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60000) {
    return cachedToken.token;
  }
  try {
    const res = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: cfg.appId, app_secret: cfg.appSecret }),
    });
    const data = await res.json() as { code?: number; tenant_access_token?: string; expire?: number };
    if (data.code === 0 && data.tenant_access_token) {
      cachedToken = {
        token: data.tenant_access_token,
        expiresAt: Date.now() + (data.expire ?? 7200) * 1000,
      };
      logger.info("task-persistence: feishu tenant token acquired");
      return cachedToken.token;
    }
    logger.warn(`task-persistence: feishu token error: code=${data.code}`);
    return null;
  } catch (err) {
    logger.warn(`task-persistence: feishu token fetch failed: ${String(err)}`);
    return null;
  }
}

/**
 * Send a message via Feishu App API.
 * @param receiveIdType "open_id" for DM, "chat_id" for group
 * @param receiveId the ou_xxx or oc_xxx id
 */
async function sendFeishuMessage(
  cfg: FeishuConfig,
  receiveIdType: "open_id" | "chat_id",
  receiveId: string,
  text: string,
  logger: { info: (m: string) => void; warn: (m: string) => void },
): Promise<boolean> {
  const token = await getFeishuTenantToken(cfg, logger);
  if (!token) return false;

  try {
    const res = await fetch(
      `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          receive_id: receiveId,
          msg_type: "text",
          content: JSON.stringify({ text }),
        }),
      },
    );
    const data = await res.json() as { code?: number; msg?: string };
    if (data.code === 0) {
      logger.info(`task-persistence: feishu message sent to ${receiveIdType}:${receiveId}`);
      return true;
    }
    logger.warn(`task-persistence: feishu send failed: code=${data.code} msg=${data.msg}`);
    return false;
  } catch (err) {
    logger.warn(`task-persistence: feishu send error: ${String(err)}`);
    return false;
  }
}

/** Extract Feishu target from session key. */
function parseFeishuTarget(sessionKey: string): { type: "open_id" | "chat_id"; id: string } | null {
  const directMatch = sessionKey.match(/feishu:direct:(ou_[a-f0-9]+)/);
  if (directMatch) return { type: "open_id", id: directMatch[1]! };
  const groupMatch = sessionKey.match(/feishu:group:(oc_[a-f0-9]+)/);
  if (groupMatch) return { type: "chat_id", id: groupMatch[1]! };
  return null;
}

/** Read Feishu credentials from OpenClaw config. */
function readFeishuConfig(config: Record<string, unknown>): FeishuConfig | null {
  try {
    const channels = config.channels as Record<string, unknown> | undefined;
    const feishu = channels?.feishu as Record<string, unknown> | undefined;
    const accounts = feishu?.accounts as Record<string, unknown> | undefined;
    if (!accounts) return null;
    // Find first account with appId + appSecret
    for (const account of Object.values(accounts)) {
      const acc = account as Record<string, unknown>;
      if (typeof acc?.appId === "string" && typeof acc?.appSecret === "string") {
        return { appId: acc.appId, appSecret: acc.appSecret };
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ── Utility ──────────────────────────────────────────────────

function safeRead<T>(filePath: string): T | null {
  try {
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

function safeWrite(filePath: string, data: unknown): void {
  try {
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  } catch {}
}

function safeDelete(filePath: string): void {
  try {
    if (existsSync(filePath)) unlinkSync(filePath);
  } catch {}
}

function truncate(text: string, max = 200): string {
  if (!text || text.length <= max) return text || "";
  return text.slice(0, max) + "...";
}

function extractUserText(messages: unknown[] | undefined): string {
  if (!messages || messages.length === 0) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as Record<string, unknown> | undefined;
    if (!msg || msg.role !== "user") continue;
    if (typeof msg.content === "string") return msg.content;
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        const b = block as Record<string, unknown>;
        if (b?.type === "text" && typeof b.text === "string") return b.text;
      }
    }
  }
  return "";
}

function isSkippable(text: string): boolean {
  if (!text) return true;
  const t = text.trim();
  if (t.length < 3) return true;
  if (/^HEARTBEAT/i.test(t)) return true;
  if (/^\[.*heartbeat.*\]/i.test(t)) return true;
  if (/^\/[a-z]/i.test(t)) return true;
  return false;
}

// ── Plugin ───────────────────────────────────────────────────

const taskPersistencePlugin = {
  id: "task-persistence",
  name: "Task Persistence",
  description: "Survives gateway restarts — auto-recovery via Feishu App API",
  kind: "utility" as const,

  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as { dataDir?: string };
    const dataDir = cfg.dataDir || api.resolvePath("~/.openclaw/workspace");
    const feishuCfg = readFeishuConfig(api.config as unknown as Record<string, unknown>);

    const pendingPath = join(dataDir, "pending-reply.json");
    const taskPath = join(dataDir, "active-task.json");

    api.logger.info(`task-persistence: initialized (dataDir=${dataDir}, feishu=${feishuCfg ? "ok" : "no-credentials"})`);

    // ── Layer 0: Gateway Start Recovery ──────────────────────────

    api.on("gateway_start", async (_event) => {
      await new Promise(r => setTimeout(r, 10000)); // wait for channels

      const pending = safeRead<PendingReply>(pendingPath);
      if (!pending) {
        api.logger.info("task-persistence: gateway_start — no pending reply");
        return;
      }

      const elapsed = Date.now() - new Date(pending.startedAt).getTime();
      const minutes = Math.round(elapsed / 60000);

      if (elapsed > 86400000) {
        api.logger.info(`task-persistence: gateway_start — pending too old (${minutes}min), cleanup`);
        safeDelete(pendingPath);
        return;
      }

      api.logger.info(`task-persistence: gateway_start — found pending (${minutes}min): "${truncate(pending.userMessage, 80)}"`);

      // Try to send via Feishu App API
      const target = parseFeishuTarget(pending.sessionKey);
      if (!target || !feishuCfg) {
        api.logger.warn(`task-persistence: cannot recover — target=${target?.id ?? "none"}, feishu=${feishuCfg ? "ok" : "none"}`);
        return;
      }

      const msgPreview = truncate(pending.userMessage, 100);
      const notifyText = elapsed < 1800000
        ? `⚠️ 网关刚重启，你 ${minutes} 分钟前的消息没回复上：\n「${msgPreview}」\n我来重新处理...`
        : `⚠️ 网关重启恢复：你 ${minutes} 分钟前的消息未回复：\n「${msgPreview}」\n需要我重新处理吗？`;

      const sent = await sendFeishuMessage(feishuCfg, target.type, target.id, notifyText, api.logger);

      if (sent) {
        api.logger.info(`task-persistence: recovery message sent to ${target.type}:${target.id}`);
        // Clear pending — the sent message will trigger the agent in that session
        safeDelete(pendingPath);
      }

      // Also notify about active-task
      const task = safeRead<ActiveTask>(taskPath);
      if (task && feishuCfg) {
        const taskElapsed = Date.now() - new Date(task.updatedAt || task.startedAt).getTime();
        if (taskElapsed < 86400000) {
          const taskMin = Math.round(taskElapsed / 60000);
          const step = task.steps.find(s => s.status === "running") ?? task.steps.find(s => s.status === "pending");
          await sendFeishuMessage(feishuCfg, target.type, target.id,
            `📋 还有未完成的任务（${taskMin}分钟前中断）：\n${task.description}\n进度：${task.currentStep}/${task.steps.length}${step ? `\n当前：${step.label}` : ""}`,
            api.logger,
          );
        }
      }
    });

    // ── Layer 1: Pending Reply Tracking ──────────────────────────

    api.on("before_agent_start", (event, ctx) => {
      const userText = extractUserText(event.messages) || event.prompt;
      if (isSkippable(userText)) return;

      const pending: PendingReply = {
        channel: ctx.channelId ?? "unknown",
        chatId: ctx.sessionKey ?? "unknown",
        sessionKey: ctx.sessionKey ?? "unknown",
        userMessage: truncate(userText, 500),
        startedAt: new Date().toISOString(),
      };
      safeWrite(pendingPath, pending);
      api.logger.info(`task-persistence: pending-reply written (${truncate(userText, 80)})`);

      // ── Layer 2: Inject active-task context ──
      const task = safeRead<ActiveTask>(taskPath);
      if (task) {
        const elapsed = Date.now() - new Date(task.updatedAt || task.startedAt).getTime();
        if (elapsed < 86400000) {
          const done = task.steps.filter(s => s.status === "done").map(s => `  ✅ ${s.label}`).join("\n");
          const remaining = task.steps.filter(s => s.status !== "done").map(s => `  ⬜ ${s.label}`).join("\n");
          const context = [
            "<active-task-context>",
            `Task: ${task.description}`,
            `Progress: step ${task.currentStep}/${task.steps.length}`,
            `Started: ${task.startedAt}`,
            done ? `Done:\n${done}` : "",
            remaining ? `Remaining:\n${remaining}` : "",
            "</active-task-context>",
          ].filter(Boolean).join("\n");

          api.logger.info(`task-persistence: injecting active-task (step ${task.currentStep}/${task.steps.length})`);
          return { prependContext: context };
        }
      }
    });

    api.on("agent_end", () => {
      safeDelete(pendingPath);
      api.logger.info("task-persistence: pending-reply cleared");
    });

    // ── Service lifecycle ──────────────────────────────────────
    api.registerService({
      id: "task-persistence",
      start: async () => {
        api.logger.info("task-persistence: service started");
      },
      stop: () => {
        api.logger.info("task-persistence: service stopped (pending-reply preserved)");
      },
    });
  },
};

export default taskPersistencePlugin;
