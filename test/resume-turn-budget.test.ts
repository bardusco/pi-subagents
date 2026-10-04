import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getGraceTurns, resumeAgent, setGraceTurns } from "../src/agent-runner.js";

function makeSession(turns: number) {
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  const messages: AgentSession["messages"] = [];
  const session = {
    messages,
    subscribe: (listener: (event: AgentSessionEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    steer: vi.fn(),
    abort: vi.fn(async () => {}),
    prompt: vi.fn(async () => {
      for (let i = 0; i < turns; i++) {
        for (const listener of [...listeners]) {
          listener({ type: "turn_end" } as AgentSessionEvent);
        }
      }
    }),
  };
  return { session: session as unknown as AgentSession, listeners, steer: session.steer, abort: session.abort, prompt: session.prompt };
}

describe("per-invocation resume turn budget", () => {
  const grace = getGraceTurns();
  afterEach(() => setGraceTurns(grace));

  it("steers once at the cap and marks the run partial", async () => {
    const s = makeSession(4);
    const result = await resumeAgent(s.session, "continue", { maxTurns: 4 });
    expect(s.steer).toHaveBeenCalledTimes(1);
    expect(s.abort).not.toHaveBeenCalled();
    expect(result.steered).toBe(true);
    expect(result.aborted).toBe(false);
    expect(s.listeners.size).toBe(0);
  });

  it("hard aborts at the cap plus existing grace", async () => {
    setGraceTurns(2);
    const s = makeSession(6);
    const result = await resumeAgent(s.session, "continue", { maxTurns: 4 });
    expect(s.steer).toHaveBeenCalledTimes(1);
    expect(s.abort).toHaveBeenCalled();
    expect(result.aborted).toBe(true);
    expect(s.listeners.size).toBe(0);
  });

  it("counts again from one and applies a new cap on each resume", async () => {
    const s = makeSession(3);
    const count = vi.fn();
    const first = await resumeAgent(s.session, "first", { maxTurns: 5, onTurnEnd: count });
    expect(first.steered).toBe(false);
    const second = await resumeAgent(s.session, "second", { maxTurns: 2, onTurnEnd: count });
    expect(second.steered).toBe(true);
    expect(count.mock.calls.map(c => c[0])).toEqual([1, 2, 3, 1, 2, 3]);
    expect(s.steer).toHaveBeenCalledTimes(1);
    expect(s.listeners.size).toBe(0);
  });

  it.each([undefined, 0])("keeps %s unlimited", async maxTurns => {
    const s = makeSession(30);
    const result = await resumeAgent(s.session, "continue", { maxTurns });
    expect(s.steer).not.toHaveBeenCalled();
    expect(s.abort).not.toHaveBeenCalled();
    expect(result.steered).toBe(false);
    expect(result.aborted).toBe(false);
    expect(s.listeners.size).toBe(0);
  });

  it("unsubscribes and preserves a rejected prompt", async () => {
    const s = makeSession(1);
    s.prompt.mockRejectedValueOnce(new Error("synthetic rejection"));
    await expect(resumeAgent(s.session, "continue", { maxTurns: 2 })).rejects.toThrow("synthetic rejection");
    expect(s.listeners.size).toBe(0);
  });

  it("continues forwarding parent cancellation and removes its listener", async () => {
    const s = makeSession(1);
    const controller = new AbortController();
    const removed = vi.spyOn(controller.signal, "removeEventListener");
    s.prompt.mockImplementationOnce(async () => { controller.abort(); });
    await resumeAgent(s.session, "continue", { maxTurns: 2, signal: controller.signal });
    expect(s.abort).toHaveBeenCalled();
    expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(s.listeners.size).toBe(0);
  });
});
