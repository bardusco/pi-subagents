import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { agentToolResults, runPrintMode } from "../helpers/print-mode-runner.js";

it.each([false, true])("real Pi Agent resume enforces the cap (ignore steering=%s)", async ignoreSteering => {
  const cwd = mkdtempSync(join(tmpdir(), "resume-budget-canary-"));
  mkdirSync(join(cwd, ".pi"));
  writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ graceTurns: 2, workflowsEnabled: false }));
  const fixture = join(cwd, "fixture.txt");
  writeFileSync(fixture, "synthetic fixture");
  let childResumeCalls = 0;
  let resumedId = "";
  const run = await runPrintMode({
    cwd,
    prompt: "Run the synthetic resume canary.",
    live: false,
    maxModelCalls: 24,
    timeoutMs: 20000,
    respond: context => {
      const history = JSON.stringify(context.messages);
      // Pi 1.0 faux requests omit context.tools; route by the parent user prompt.
      const isParent = context.messages.some(message => message.role === "user" && JSON.stringify(message.content).includes("Run the synthetic resume canary."));
      if (!isParent) {
        if (!history.includes("RESUME-MARKER")) return fauxText("initial answer");
        childResumeCalls++;
        if (!ignoreSteering && history.includes("Wrap up immediately")) return fauxText("canary partial");
        return fauxToolCall("read", { path: fixture }, { id: "read-" + childResumeCalls });
      }
      const results = context.messages.filter(message => message.role === "toolResult" && message.toolName === "Agent");
      if (results.length === 0) return fauxToolCall("Agent", {
        prompt: "INITIAL-MARKER", description: "Initial synthetic run", subagent_type: "general-purpose", run_in_background: true,
      }, { id: "initial-call" });
      if (results.length === 1) {
        const id = /Agent ID: (\S+)/.exec(JSON.stringify(results[0]))?.[1];
        if (!id) throw new Error("missing spawned id");
        resumedId = id.replace(/\\n.*$/, "");
        if (!context.messages.some(message => message.role === "toolResult" && message.toolName === "get_subagent_result")) {
          return fauxToolCall("get_subagent_result", { agent_id: resumedId, wait: true }, { id: "await-initial" });
        }
        return fauxToolCall("Agent", {
          prompt: "RESUME-MARKER", description: "Resume synthetic run", subagent_type: "general-purpose",
          resume: id.replace(/\\n.*$/, ""), run_in_background: false, max_turns: 2,
        }, { id: "resume-call" });
      }
      return fauxText("canary finished");
    },
  });
  try {
    const record = run.manager?.getRecord(resumedId) as { status: string } | undefined;
    expect(record?.status, agentToolResults(run.parentSession).join("\n")).toBe(ignoreSteering ? "aborted" : "steered");
    // The SDK makes one final cancelled stream call while settling abort.
    expect(childResumeCalls).toBe(ignoreSteering ? 5 : 3);
    expect(agentToolResults(run.parentSession).at(-1)).toContain(ignoreSteering ? "aborted at the turn limit" : "wrapped up at the turn limit");
  } finally {
    await run.dispose();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 30000);
