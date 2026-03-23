/**
 * task-persistence — OpenClaw plugin
 *
 * Layer 1: Writes pending-reply.json on before_agent_start, deletes on agent_end.
 *          HEARTBEAT.md reads this file to recover from gateway crashes.
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
    // silent — don't crash the agent over persistence
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

/** Extract plain text from the latest user message. */
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

/** Skip heartbeat / system / command messages. */
function isSkippable(text: string): boolean {
  if (!text) return true;
  const t = text.trim();
  if (t.length < 3) return true;
  if (/^HEARTBEAT/i.test(t)) return true;
  if (/^\[.*heartbeat.*\]/i.test(t)) return true;
  if (/^\/[a-z]/i.test(t)) return true;
  return false;
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

    // ── Layer 1: Pending Reply Tracking ──────────────────────────

    api.on("before_agent_start", (event, ctx) => {
      const userText = extractUserText(event.messages) || event.prompt;
      if (isSkippable(userText)) return;

      // Write pending-reply so HEARTBEAT can detect unfinished responses
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
        // Do NOT delete pending-reply here — graceful restart mid-response
        // looks the same as a crash from the user's perspective.
        // Only agent_end (successful reply) should clear it.
        api.logger.info("task-persistence: service stopped (pending-reply preserved)");
      },
    });
  },
};

export default taskPersistencePlugin;
