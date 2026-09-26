import assert from "node:assert/strict";
import test from "node:test";
import { AgentRunScheduler, onAgentWork } from "./scheduler";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
};

test("runs two projects concurrently and serializes the same project", async () => {
  const scheduler = new AgentRunScheduler(2, 4);
  const first = deferred();
  const second = deferred();
  const started: string[] = [];
  const a1 = scheduler.run("a", undefined, async () => {
    started.push("a1");
    await first.promise;
  });
  const a2 = scheduler.run("a", undefined, async () => started.push("a2"));
  const b1 = scheduler.run("b", undefined, async () => {
    started.push("b1");
    await second.promise;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduler.hasWork(), true);
  assert.deepEqual(started, ["a1", "b1"]);
  first.resolve();
  await a1;
  await a2;
  second.resolve();
  await b1;
  assert.equal(scheduler.hasWork(), false);
  assert.deepEqual(started, ["a1", "b1", "a2"]);
});

test("removes a cancelled waiter and releases the slot", async () => {
  const scheduler = new AgentRunScheduler(1, 2);
  const running = deferred();
  const first = scheduler.run("a", undefined, () => running.promise);
  const controller = new AbortController();
  const cancelled = scheduler.run("b", controller.signal, async () => undefined);
  controller.abort();
  await assert.rejects(cancelled, { name: "AbortError" });
  running.resolve();
  await first;
  await scheduler.run("c", undefined, async () => undefined);
});

test("bounds the burst queue at six total runs", async () => {
  const scheduler = new AgentRunScheduler(2, 4);
  const gates = Array.from({ length: 6 }, deferred);
  const jobs = gates.map((gate, index) => scheduler.run(String(index), undefined, () => gate.promise));
  await assert.rejects(scheduler.run("overflow", undefined, async () => undefined), /排队已满/);
  gates.forEach((gate) => gate.resolve());
  await Promise.all(jobs);
});

test("notifies background work when an interactive run arrives", async () => {
  const scheduler = new AgentRunScheduler(1, 1);
  let notified = 0;
  const remove = onAgentWork(() => notified++);
  await scheduler.run("project", undefined, async () => undefined);
  remove();
  assert.equal(notified, 1);
});
