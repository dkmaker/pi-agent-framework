/**
 * Agent self-management tools — new session and reload.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { execSync } from "child_process";

function selfTmuxSend(text: string, pressEnter = true) {
  const tmuxEnv = process.env.TMUX;
  if (!tmuxEnv) throw new Error("Not running inside tmux.");
  const [socket] = tmuxEnv.split(",");
  const pane = process.env.TMUX_PANE || "";
  const paneArg = pane ? `-t '${pane}'` : "";
  execSync(
    `tmux -S '${socket}' send-keys ${paneArg} '${text.replace(/'/g, "'\\''")}' ${pressEnter ? "Enter" : ""}`,
    { timeout: 5000 }
  );
}

export function registerTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "agent_new_session",
    label: "New Session",
    description:
      "Start a fresh session with a continuation prompt. " +
      "Injects /new into your own tmux session, then sends the prompt. " +
      "This is a terminal operation — your current turn ends.",
    parameters: Type.Object({
      prompt: Type.String({ description: "Continuation prompt for the fresh session" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { prompt } = params as { prompt: string };
      if (!prompt.trim()) {
        return { content: [{ type: "text", text: "A continuation prompt is required." }], isError: true };
      }

      ctx?.abort?.();

      const delayMs = 3000;
      setTimeout(() => {
        selfTmuxSend("/new", true);
        setTimeout(() => {
          const tmuxEnv = process.env.TMUX;
          if (!tmuxEnv) return;
          const [socket] = tmuxEnv.split(",");
          const pane = process.env.TMUX_PANE || "";
          const paneArg = pane ? `-t '${pane}'` : "";
          try {
            execSync(`tmux -S '${socket}' load-buffer -`, { input: prompt, timeout: 5000 });
            execSync(`tmux -S '${socket}' paste-buffer -d ${paneArg}`, { timeout: 5000 });
            execSync(`tmux -S '${socket}' send-keys ${paneArg} Enter`, { timeout: 5000 });
          } catch { /* best effort */ }
        }, delayMs);
      }, 500);

      return { content: [{ type: "text", text: `Starting fresh session → injecting prompt after ${delayMs / 1000}s.` }] };
    },
  });

  pi.registerTool({
    name: "agent_reload",
    label: "Reload Extensions",
    description:
      "Reload extensions in your own session by injecting /reload. " +
      "Use after editing your AGENTS.md or other config. " +
      "This is a terminal operation — your current turn ends.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      ctx?.abort?.();

      setTimeout(() => {
        selfTmuxSend("/reload", true);
      }, 500);

      return { content: [{ type: "text", text: "Injecting /reload — session will restart momentarily." }] };
    },
  });
}
