import { EventEmitter } from "node:events";
import { Readable, PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  getDefaultCliArgs,
  parseArgs,
  runCli,
} from "./codexAppServerRunner.js";

class FakeAppServer extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly requests: any[] = [];
  private bufferedStdin = "";

  constructor() {
    super();

    this.stdin.on("data", (chunk) => {
      this.bufferedStdin += chunk.toString("utf8");
      let lineEnd = this.bufferedStdin.indexOf("\n");

      while (lineEnd !== -1) {
        const line = this.bufferedStdin.slice(0, lineEnd);
        this.bufferedStdin = this.bufferedStdin.slice(lineEnd + 1);
        if (line.length > 0) {
          this.handleInput(JSON.parse(line));
        }
        lineEnd = this.bufferedStdin.indexOf("\n");
      }
    });
  }

  kill(): boolean {
    queueMicrotask(() => this.emit("exit", 0, null));
    return true;
  }

  private handleInput(message: any): void {
    this.requests.push(message);

    if (message.id === undefined) {
      return;
    }

    switch (message.method) {
      case "initialize":
        this.writeOutput({ id: message.id, result: {} });
        break;
      case "thread/start":
        this.writeOutput({
          id: message.id,
          result: { thread: { id: "thread-1" } },
        });
        break;
      case "turn/start":
        this.writeOutput({
          id: message.id,
          result: { turn: { id: "turn-1" } },
        });
        queueMicrotask(() => {
          this.writeOutput({
            method: "item/agentMessage/delta",
            params: { delta: "hello" },
          });
          this.writeOutput({
            method: "item/completed",
            params: { item: { type: "agentMessage", text: "done" } },
          });
          this.writeOutput({
            method: "turn/completed",
            params: {
              threadId: "thread-1",
              turn: { id: "turn-1", status: "completed" },
            },
          });
        });
        break;
    }
  }

  private writeOutput(message: unknown): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }
}

const captureOutput = () => {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString("utf8"));
      callback();
    },
  });

  return {
    stream,
    lines: () =>
      chunks
        .join("")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
  };
};

describe("codex app-server runner args", () => {
  it("normalizes Node -e argv shapes", () => {
    expect(getDefaultCliArgs(["/usr/bin/node", "--model", "gpt-5.5"])).toEqual([
      "--model",
      "gpt-5.5",
    ]);
    expect(
      getDefaultCliArgs(["/usr/bin/node", "[eval]", "--model", "gpt-5.5"]),
    ).toEqual(["--model", "gpt-5.5"]);
    expect(
      getDefaultCliArgs([
        "/usr/bin/node",
        "[eval]",
        "--",
        "--model",
        "gpt-5.5",
      ]),
    ).toEqual(["--model", "gpt-5.5"]);
    expect(
      getDefaultCliArgs([
        "/usr/bin/node",
        "/app/runner.js",
        "--model",
        "gpt-5.5",
      ]),
    ).toEqual(["--model", "gpt-5.5"]);
  });

  it("parses model and effort flags", () => {
    expect(parseArgs(["--model", "gpt-5.5", "--effort", "low"])).toEqual({
      model: "gpt-5.5",
      effort: "low",
    });
  });

  it("rejects missing flag values", () => {
    expect(() => parseArgs(["--model"])).toThrow("Missing value for --model");
    expect(() => parseArgs(["--model", "--effort"])).toThrow(
      "Missing value for --model",
    );
  });
});

describe("codex app-server runner", () => {
  it("drives app-server stdio and emits Sandcastle stream events", async () => {
    const appServer = new FakeAppServer();
    const stdout = captureOutput();
    const exits: number[] = [];
    const spawnCalls: any[] = [];

    await runCli(
      getDefaultCliArgs([
        "/usr/bin/node",
        "[eval]",
        "--model",
        "gpt-5.5",
        "--effort",
        "low",
      ]),
      {
        spawn: (command, args, options) => {
          spawnCalls.push({ command, args, options });
          return appServer;
        },
        stdin: Readable.from(["do the work"]),
        stdout: stdout.stream,
        stderr: new Writable({ write: (_chunk, _encoding, done) => done() }),
        env: { OPENAI_KEY: "sk-openai-key" },
        cwd: () => "/repo",
        exit: (code) => {
          exits.push(code);
        },
      },
    );

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].command).toBe("codex");
    expect(spawnCalls[0].args).toEqual(["app-server", "--listen", "stdio://"]);
    expect(spawnCalls[0].options.env.OPENAI_API_KEY).toBe("sk-openai-key");
    expect(spawnCalls[0].options.env.CODEX_HOME).toBe("/home/agent/.codex");

    const turnStart = appServer.requests.find(
      (request) => request.method === "turn/start",
    );
    expect(turnStart.params).toMatchObject({
      threadId: "thread-1",
      cwd: "/repo",
      model: "gpt-5.5",
      effort: "low",
      input: [{ type: "text", text: "do the work", text_elements: [] }],
    });
    expect(stdout.lines()).toEqual([
      {
        type: "item.delta",
        item: { type: "agent_message_delta", text: "hello" },
      },
      {
        type: "item.completed",
        item: { type: "agent_message", text: "done" },
      },
    ]);
    expect(exits).toEqual([0]);
  });

  it("omits effort from turn/start when no effort is provided", async () => {
    const appServer = new FakeAppServer();

    await runCli(["--model", "gpt-5.5"], {
      spawn: () => appServer,
      stdin: Readable.from(["do the work"]),
      stdout: captureOutput().stream,
      stderr: new Writable({ write: (_chunk, _encoding, done) => done() }),
      env: {},
      exit: () => {},
    });

    const turnStart = appServer.requests.find(
      (request) => request.method === "turn/start",
    );
    expect(turnStart.params).not.toHaveProperty("effort");
  });
});
