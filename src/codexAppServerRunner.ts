import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

interface ParsedArgs {
  readonly model?: string;
  readonly effort?: string;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

export async function runCli(argv = process.argv.slice(1)): Promise<void> {
  const args = parseArgs(argv);
  const prompt = await readStdin();

  if (!args.model) {
    throw new Error("Missing required --model argument.");
  }

  if (process.env.OPENAI_KEY && !process.env.OPENAI_API_KEY) {
    process.env.OPENAI_API_KEY = process.env.OPENAI_KEY;
  }

  const appServer = spawn("codex", ["app-server", "--listen", "stdio://"], {
    env: {
      ...process.env,
      CODEX_HOME: process.env.CODEX_HOME ?? "/home/agent/.codex",
      NO_COLOR: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let nextRequestId = 1;
  let threadId: string | null = null;
  let activeTurnId: string | null = null;
  let exited = false;
  const pendingRequests = new Map<number, PendingRequest>();

  appServer.stderr.pipe(process.stderr);

  const stdoutLines = createInterface({ input: appServer.stdout });
  stdoutLines.on("line", (line) => {
    void handleAppServerLine(line);
  });

  appServer.on("exit", (code, signal) => {
    if (exited) {
      return;
    }

    const reason = signal ? `signal ${signal}` : `exit code ${code ?? 0}`;
    emitError(`codex app-server exited before the turn completed (${reason}).`);
    process.exit(code ?? 1);
  });

  try {
    await request("initialize", {
      clientInfo: {
        name: "sandcastle-codex-app-server",
        title: "Sandcastle Codex App Server",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });

    notify("initialized");

    const threadStart = await request("thread/start", {
      model: args.model,
      cwd: process.cwd(),
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "danger-full-access",
      serviceName: "sandcastle",
      ephemeral: true,
      threadSource: "subagent",
    });

    threadId = getNestedString(threadStart, ["thread", "id"]);

    if (!threadId) {
      throw new Error("codex app-server did not return a thread id.");
    }

    const turnStart = await request("turn/start", {
      threadId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
      cwd: process.cwd(),
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "dangerFullAccess" },
      model: args.model,
      effort: args.effort ?? null,
    });

    activeTurnId = getNestedString(turnStart, ["turn", "id"]);
  } catch (error) {
    emitError(error instanceof Error ? error.message : String(error));
    await shutdown(1);
  }

  function request(method: string, params: unknown): Promise<unknown> {
    const id = nextRequestId++;
    appServer.stdin.write(`${JSON.stringify({ id, method, params })}\n`);

    return new Promise((resolve, reject) => {
      pendingRequests.set(id, { resolve, reject });
    });
  }

  function notify(method: string, params?: unknown): void {
    const message = params === undefined ? { method } : { method, params };
    appServer.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async function handleAppServerLine(line: string): Promise<void> {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    if (message.id !== undefined && pendingRequests.has(message.id)) {
      const pending = pendingRequests.get(message.id)!;
      pendingRequests.delete(message.id);

      if (message.error) {
        pending.reject(
          new Error(message.error.message ?? JSON.stringify(message.error)),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.id !== undefined && message.method) {
      handleServerRequest(message);
      return;
    }

    if (!message.method) {
      return;
    }

    switch (message.method) {
      case "item/started":
        handleItemStarted(message.params);
        break;
      case "item/agentMessage/delta":
        handleAgentMessageDelta(message.params);
        break;
      case "item/completed":
        handleItemCompleted(message.params);
        break;
      case "item/commandExecution/outputDelta":
      case "command/exec/outputDelta":
      case "process/outputDelta":
      case "item/plan/delta":
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
        emit({ type: "heartbeat" });
        break;
      case "error":
        emitError(
          message.params?.error?.message ?? JSON.stringify(message.params),
        );
        break;
      case "turn/completed":
        await handleTurnCompleted(message.params);
        break;
    }
  }

  function handleServerRequest(message: any): void {
    switch (message.method) {
      case "item/commandExecution/requestApproval":
        respond(message.id, { decision: "accept" });
        break;
      case "item/fileChange/requestApproval":
        respond(message.id, { decision: "accept" });
        break;
      case "item/permissions/requestApproval":
        respond(message.id, {
          permissions: message.params?.permissions ?? {},
          scope: "session",
        });
        break;
      case "mcpServer/elicitation/request":
        respond(message.id, { action: "cancel", content: null, _meta: null });
        break;
      case "item/tool/requestUserInput":
        respond(message.id, { answers: {} });
        break;
      case "item/tool/call":
        respond(message.id, { contentItems: [], success: false });
        break;
      case "account/chatgptAuthTokens/refresh":
        respondWithCurrentAuthTokens(message.id);
        break;
      default:
        rejectRequest(
          message.id,
          `Unsupported app-server request: ${message.method}`,
        );
        break;
    }
  }

  function respondWithCurrentAuthTokens(id: number): void {
    try {
      const authPath = join(
        process.env.CODEX_HOME ?? "/home/agent/.codex",
        "auth.json",
      );
      const auth = JSON.parse(readFileSync(authPath, "utf8"));
      const accessToken = auth.tokens?.access_token;
      const chatgptAccountId = auth.tokens?.account_id;

      if (
        typeof accessToken !== "string" ||
        typeof chatgptAccountId !== "string"
      ) {
        throw new Error("auth.json does not contain ChatGPT tokens.");
      }

      respond(id, {
        accessToken,
        chatgptAccountId,
        chatgptPlanType: null,
      });
    } catch (error) {
      rejectRequest(
        id,
        error instanceof Error
          ? error.message
          : "Unable to read ChatGPT auth tokens.",
      );
    }
  }

  function respond(id: number, result: unknown): void {
    appServer.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }

  function rejectRequest(id: number, message: string): void {
    appServer.stdin.write(
      `${JSON.stringify({ id, error: { code: -32000, message } })}\n`,
    );
  }

  function handleItemStarted(params: any): void {
    if (params?.item?.type !== "commandExecution") {
      return;
    }

    emit({
      type: "item.started",
      item: {
        type: "command_execution",
        command: params.item.command,
      },
    });
  }

  function handleAgentMessageDelta(params: any): void {
    if (typeof params?.delta !== "string" || params.delta.length === 0) {
      return;
    }

    emit({
      type: "item.delta",
      item: {
        type: "agent_message_delta",
        text: params.delta,
      },
    });
  }

  function handleItemCompleted(params: any): void {
    if (params?.item?.type !== "agentMessage") {
      return;
    }

    emit({
      type: "item.completed",
      item: {
        type: "agent_message",
        text: params.item.text,
      },
    });
  }

  async function handleTurnCompleted(params: any): Promise<void> {
    if (params.threadId !== threadId) {
      return;
    }

    const turn = params.turn;
    if (activeTurnId && turn?.id !== activeTurnId) {
      return;
    }

    if (turn?.status === "failed") {
      emitError(turn.error?.message ?? "Codex turn failed.");
      await shutdown(1);
      return;
    }

    await shutdown(0);
  }

  function emit(event: unknown): void {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  }

  function emitError(message: string): void {
    emit({ type: "error", message });
  }

  async function shutdown(code: number): Promise<void> {
    if (exited) {
      return;
    }

    exited = true;
    stdoutLines.close();
    appServer.stdin.end();
    appServer.kill("SIGTERM");

    try {
      await Promise.race([
        once(appServer, "exit"),
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]);
    } catch {
      // Best-effort shutdown.
    }

    process.exit(code);
  }
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: { model?: string; effort?: string } = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--model") {
      parsed.model = argv[++i];
      continue;
    }
    if (arg === "--effort") {
      parsed.effort = argv[++i];
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function getNestedString(
  value: unknown,
  path: readonly string[],
): string | null {
  let cursor: unknown = value;
  for (const key of path) {
    if (typeof cursor !== "object" || cursor === null || !(key in cursor)) {
      return null;
    }
    cursor = (cursor as Record<string, unknown>)[key];
  }

  return typeof cursor === "string" ? cursor : null;
}
