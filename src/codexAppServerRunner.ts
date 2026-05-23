import { spawn } from "node:child_process";
import { once, type EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const DEFAULT_CODEX_HOME = "/home/agent/.codex";

interface ParsedArgs {
  readonly model?: string;
  readonly effort?: string;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

interface AppServerProcess extends EventEmitter {
  readonly stdin: NodeJS.WritableStream;
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  kill(signal?: NodeJS.Signals): boolean;
}

type SpawnAppServer = (
  command: string,
  args: string[],
  options: {
    readonly env: NodeJS.ProcessEnv;
    readonly stdio: ["pipe", "pipe", "pipe"];
  },
) => AppServerProcess;

interface RunCliOptions {
  readonly spawn?: SpawnAppServer;
  readonly stdin?: NodeJS.ReadableStream;
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: () => string;
  readonly exit?: (code: number) => void;
}

export async function runCli(
  argv = getDefaultCliArgs(process.argv),
  options: RunCliOptions = {},
): Promise<void> {
  const args = parseArgs(argv);
  const prompt = await readStdin(options.stdin ?? process.stdin);

  if (!args.model) {
    throw new Error("Missing required --model argument.");
  }

  const runnerEnv: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };
  if (runnerEnv.OPENAI_KEY && !runnerEnv.OPENAI_API_KEY) {
    runnerEnv.OPENAI_API_KEY = runnerEnv.OPENAI_KEY;
  }
  runnerEnv.CODEX_HOME ??= DEFAULT_CODEX_HOME;
  runnerEnv.NO_COLOR = "1";

  const spawnAppServer =
    options.spawn ??
    ((command, commandArgs, spawnOptions) =>
      spawn(command, commandArgs, spawnOptions) as AppServerProcess);
  const output = options.stdout ?? process.stdout;
  const errorOutput = options.stderr ?? process.stderr;
  const getCwd = options.cwd ?? (() => process.cwd());
  const exit =
    options.exit ??
    ((code: number) => {
      process.exit(code);
    });

  const appServer = spawnAppServer(
    "codex",
    ["app-server", "--listen", "stdio://"],
    {
      env: runnerEnv,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  let nextRequestId = 1;
  let threadId: string | null = null;
  let activeTurnId: string | null = null;
  let exited = false;
  const pendingRequests = new Map<number, PendingRequest>();
  let resolveFinished!: () => void;
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });

  appServer.stderr.pipe(errorOutput);

  const stdoutLines = createInterface({ input: appServer.stdout });
  stdoutLines.on("line", (line) => {
    void handleAppServerLine(line).catch(async (error: unknown) => {
      emitError(error instanceof Error ? error.message : String(error));
      await shutdown(1);
    });
  });

  appServer.on("exit", (code, signal) => {
    if (exited) {
      return;
    }

    exited = true;
    const reason = signal ? `signal ${signal}` : `exit code ${code ?? 0}`;
    emitError(`codex app-server exited before the turn completed (${reason}).`);
    exit(code ?? 1);
    resolveFinished();
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
      cwd: getCwd(),
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
      cwd: getCwd(),
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "dangerFullAccess" },
      model: args.model,
      ...(args.effort ? { effort: args.effort } : {}),
    });

    activeTurnId = getNestedString(turnStart, ["turn", "id"]);
  } catch (error) {
    emitError(error instanceof Error ? error.message : String(error));
    await shutdown(1);
  }

  await finished;

  function request(method: string, params: unknown): Promise<unknown> {
    const id = nextRequestId++;

    return new Promise((resolve, reject) => {
      pendingRequests.set(id, { resolve, reject });
      appServer.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
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
        runnerEnv.CODEX_HOME ?? DEFAULT_CODEX_HOME,
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
    output.write(`${JSON.stringify(event)}\n`);
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

    exit(code);
    resolveFinished();
  }
}

export function getDefaultCliArgs(processArgv: readonly string[]): string[] {
  const [, firstArg, ...rest] = processArgv;

  if (firstArg === undefined) {
    return [];
  }

  const args =
    firstArg === "[eval]" || firstArg === "--" || !firstArg.startsWith("-")
      ? rest
      : [firstArg, ...rest];

  return args[0] === "--" ? args.slice(1) : args;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: { model?: string; effort?: string } = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--model") {
      parsed.model = readArgValue(argv, ++i, arg);
      continue;
    }
    if (arg === "--effort") {
      parsed.effort = readArgValue(argv, ++i, arg);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

function readArgValue(
  argv: readonly string[],
  index: number,
  flag: string,
): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}.`);
  }
  return value;
}

async function readStdin(input: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) {
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
