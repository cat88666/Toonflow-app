import jwt from "jsonwebtoken";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

type Options = { namespace: "scriptAgent" | "productionAgent"; prompt: string; output: string; timeoutSeconds: number; projectId?: number };

function options(): Options {
  const values = process.argv.slice(2);
  const read = (name: string) => {
    const index = values.indexOf(name);
    return index >= 0 ? values[index + 1] : undefined;
  };
  const namespace = read("--namespace") as Options["namespace"];
  const prompt = read("--prompt");
  const output = read("--output");
  if (!namespace || !["scriptAgent", "productionAgent"].includes(namespace) || !prompt || !output) {
    throw new Error("usage: socketE2E.ts --namespace <scriptAgent|productionAgent> --prompt <text> --output <file> [--timeout 600] [--project-id ID]");
  }
  const projectId = read("--project-id");
  return { namespace, prompt, output, timeoutSeconds: Number(read("--timeout") ?? 600), projectId: projectId ? Number(projectId) : undefined };
}

async function post(url: string, body: string) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "text/plain;charset=UTF-8" }, body });
  if (!response.ok) throw new Error(`Socket.IO POST ${response.status}: ${await response.text()}`);
}

async function main() {
  const input = options();
  const query = (sql: string) => execFileSync("sqlite3", ["data/db2.sqlite", sql], { encoding: "utf8" }).trim();
  const tokenKey = query("select value from o_setting where key='tokenKey'");
  const project = { id: input.projectId ?? Number(query("select id from o_project order by id limit 1")) };
  if (query(`select count(*) from o_project where id=${project.id}`) !== "1") throw new Error(`project ${project.id} does not exist`);
  const scriptId = query(`select id from o_script where projectId=${project.id} order by id limit 1`);
  const token = jwt.sign({ sub: "socket-e2e" }, tokenKey, { expiresIn: "1h" });

  const endpoint = "http://127.0.0.1:10588/socket.io/";
  const handshake = await fetch(`${endpoint}?EIO=4&transport=polling&t=${Date.now()}`).then((response) => response.text());
  if (!handshake.startsWith("0")) throw new Error(`invalid Engine.IO handshake: ${handshake.slice(0, 200)}`);
  const sid = JSON.parse(handshake.slice(1)).sid;
  const pollURL = `${endpoint}?EIO=4&transport=polling&sid=${encodeURIComponent(sid)}&t=`;
  const namespace = `/api/socket/${input.namespace}`;
  const auth = { token, isolationKey: `e2e-${input.namespace}-${Date.now()}`, projectId: project.id, scriptId: scriptId ? Number(scriptId) : undefined };
  await post(pollURL + Date.now(), `40${namespace},${JSON.stringify(auth)}`);
  const connected = await fetch(pollURL + Date.now()).then((response) => response.text());
  if (!connected.includes(`40${namespace},`)) throw new Error(`namespace connection failed: ${connected.slice(0, 500)}`);
  await post(pollURL + Date.now(), `42${namespace},${JSON.stringify(["chat", { content: input.prompt }])}`);

  const started = Date.now();
  const deadline = started + input.timeoutSeconds * 1000;
  const events: { name: string; data: any }[] = [];
  let terminalSeen = false;
  const pendingMessages = new Set<string>();
  while (Date.now() < deadline) {
    const idleTimeout = terminalSeen && pendingMessages.size === 0 ? 5000 : 30000;
    let payload: string;
    try {
      payload = await fetch(pollURL + Date.now(), { signal: AbortSignal.timeout(idleTimeout) }).then((response) => response.text());
    } catch (error: any) {
      if (terminalSeen && pendingMessages.size === 0 && error?.name === "TimeoutError") break;
      throw error;
    }
    for (const packet of payload.split("\x1e")) {
      if (packet === "2") {
        await post(pollURL + Date.now(), "3");
        continue;
      }
      const prefix = `42${namespace},`;
      if (!packet.startsWith(prefix)) continue;
      const rawEventPayload = packet.slice(prefix.length);
      const ackMatch = rawEventPayload.match(/^(\d+)(?=\[)/);
      const ackId = ackMatch?.[1];
      const eventPayload = rawEventPayload.replace(/^\d+(?=\[)/, "");
      let decoded: [string, any];
      try {
        decoded = JSON.parse(eventPayload);
      } catch (error) {
        throw new Error(`invalid Socket.IO event packet ${eventPayload.slice(0, 200)}`, { cause: error });
      }
      const [name, data] = decoded;
      events.push({ name, data });
      if (ackId) {
        const response =
          name === "getPlanData"
            ? { storySkeleton: "E2E 测试故事骨架", adaptationStrategy: "E2E 测试改编策略", script: "E2E 测试剧本上下文" }
            : name === "getFlowData"
              ? { name: "E2E", duration: "5", resolution: "768P", fps: "24", script: "E2E 剧本", scriptPlan: "", assets: [], storyboardTable: "", storyboard: [] }
              : "ok";
        await post(pollURL + Date.now(), `43${namespace},${ackId}${JSON.stringify([response])}`);
      }
      if (name === "message") {
        pendingMessages.add(data.id);
      }
      if (name === "message:update" && ["complete", "error", "stop"].includes(data.status)) {
        terminalSeen = true;
        pendingMessages.delete(data.id);
      }
    }
  }
  await post(pollURL + Date.now(), `41${namespace},`).catch(() => undefined);
  if (!terminalSeen) throw new Error(`Socket.IO task did not reach a terminal message state in ${input.timeoutSeconds}s`);
  const errors = events.filter((event) => event.name === "message:update" && event.data.status === "error");
  const text = events
    .filter((event) => event.name === "content:update" && typeof event.data.data === "string")
    .map((event) => event.data.data)
    .join("");
  const result = {
    namespace: input.namespace,
    seconds: (Date.now() - started) / 1000,
    events: events.length,
    errors,
    pendingMessages: [...pendingMessages],
    text,
  };
  fs.writeFileSync(input.output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, text: text.slice(0, 500) }, null, 2));
  if (errors.length > 0 || pendingMessages.size > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
