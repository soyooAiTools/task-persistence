/**
 * task-persistence — OpenClaw plugin
 *
 * Layer 1: Writes pending-reply.json on before_agent_start, deletes on agent_end.
 *          On gateway_start, checks for leftover pending-reply and sends a
 *          Feishu webhook notification to trigger recovery.
 *
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

// Feishu custom bot webhook for recovery notifications
const FEISHU_WEBHOOK = "https://open.feishu.cn/open-apis/bot/v2/hook/b9c59492-4949-4950-a34b-913bf1c7df08";

// Map session keys to Feishu chat IDs for targeted recovery
// Format: "agent:main:feishu:direct:ou_xxx" → send to user ou_xxx
// Format: "agent:main:feishu:group:oc_xxx" → send to group oc_xxx
function extractFeishuTarget(sessionKey: string): { type: "user" | "group"; id: string } | null {
  const directMatch = sessionKey.match(/feishu:direct:(ou_[a-f0-9]+)/);
  if (directMatch) return { type: "user", id: directMatch[1]! };
  const groupMatch = sessionKey.match(/feishu:group:(oc_[a-f0-9]+)/);
  if (groupMatch) return { type: "group", id: groupMatch[1]! };
  return null;
}

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
  } catch {
    // silent
  }
}

function safeDelete(filePath: string): void {
  try {
    if (existsSync(filePath)) unlinkSync(filePath);
  } catch {
    // silent
  }
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

/** Send a Feishu webhook message (custom bot). */
async function sendFeishuWebhook(text: string, logger: { info: (m: string) => void; warn: (m: string) => void }): Promise<boolean> {
  try {
    const res = await fetch(FEISHU_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        msg_type: "text",
        content: { text },
      }),
    });
    if (res.ok) {
      logger.info(`task-persistence: feishu webhook sent (${res.status})`);
      return true;
    }
    logger.warn(`task-persistence: feishu webhook failed (${res.status})`);
    return false;
  } catch (err) {
    logger.warn(`task-persistence: feishu webhook error: ${String(err)}`);
    return false;
  }
}

const taskPersistencePlugin = {
  id: "task-persistence",
  name: "Task Persistence",
  description: "Survives gateway restarts — Layer 1 (pending reply) + Layer 2 (active task checkpoints)",
  kind: "utility" as const,

  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as { dataDir?: string };
    const dataDir = cfg.dataDir || api.resolvePath("~/.openclaw/workspace");

    const pendingPath = join(dataDir, "pending-reply.json");
    const taskPath = join(dataDir, "active-task.json");

    api.logger.info(`task-persistence: initialized (dataDir=${dataDir})`);

    // ── Layer 0: Gateway Start Recovery ──────────────────────────

    api.on("gateway_start", async (event) => {
      // Wait for channels to initialize
      await new Promise(r => setTimeout(r, 8000));

      const pending = safeRead<PendingReply>(pendingPath);
      if (!pending) {
        api.logger.info("task-persistence: gateway_start — no pending reply found");
        return;
      }

      const elapsed = Date.now() - new Date(pending.startedAt).getTime();
      const minutes = Math.round(elapsed / 60000);

      // Too old (> 24h) — just clean up
      if (elapsed > 86400000) {
        api.logger.info(`task-persistence: gateway_start — pending reply too old (${minutes}min), cleaning up`);
        safeDelete(pendingPath);
        return;
      }

      api.logger.info(`task-persistence: gateway_start — found pending reply (${minutes}min old): "${truncate(pending.userMessage, 80)}"`);

      // Build recovery message
      const msgPreview = truncate(pending.userMessage, 100);
      let notifyText: string;

      if (elapsed < 1800000) {
        // < 30 min — auto-recover
        notifyText = `⚠️ 网关刚重启，你 ${minutes} 分钟前的消息没回复上：\n「${msgPreview}」\n正在重新处理...`;
      } else {
        // 30min ~ 24h — ask user
        notifyText = `⚠️ 网关重启恢复通知：你 ${minutes} 分钟前的消息未回复：\n「${msgPreview}」\n需要我重新处理吗？`;
      }

      // Send via Feishu webhook
      const sent = await sendFeishuWebhook(notifyText, api.logger);

      if (sent) {
        api.logger.info("task-persistence: recovery notification sent via feishu webhook");
        // Don't delete pending-reply yet — let the agent handle it via HEARTBEAT
        // or the user will reply and trigger normal flow
      }

      // Also check active-task
      const task = safeRead<ActiveTask>(taskPath);
      if (task) {
        const taskElapsed = Date.now() - new Date(task.updatedAt || task.startedAt).getTime();
        if (taskElapsed < 86400000) {
          const taskMinutes = Math.round(taskElapsed / 60000);
          const step = task.steps.find(s => s.status === "running") ?? task.steps.find(s => s.status === "pending");
          const stepLabel = step ? `当前步骤：${step.label}` : "";
          await sendFeishuWebhook(
            `📋 还有一个未完成的任务（${taskMinutes}分钟前中断）：\n${task.description}\n进度：${task.currentStep}/${task.steps.length}\n${stepLabel}`,
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

      // ── Layer 2: Inject active-task context if present ──
      const task = safeRead<ActiveTask>(taskPath);
      if (task) {
        const elapsed = Date.now() - new Date(task.updatedAt || task.startedAt).getTime();
        const hours = elapsed / 3600000;
        if (hours < 24) {
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
