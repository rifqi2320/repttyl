import type { AgentClient } from "@repttyl/protocol-client";
import type { ReadStream, WriteStream } from "node:tty";

type TerminalPresentationIO = {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  error: NodeJS.WriteStream;
};

export async function attachTerminalPresentation(
  client: AgentClient,
  workspaceID: string,
  session: string,
  io: TerminalPresentationIO,
): Promise<void> {
  const cols = terminalCols(io.output);
  const rows = terminalRows(io.output);
  const { stream } = await client.attachTerminal(workspaceID, cols, rows, session);

  const unsubscribeOutput = client.onTerminalOutput((message) => {
    if (message.stream === stream) {
      io.output.write(message.data);
    }
  });

  const unsubscribeError = client.onTerminalError((message) => {
    if (message.stream === stream) {
      io.error.write(`\n${message.error.code}: ${message.error.message}\n`);
    }
  });

  const wasRaw = isTTYReadStream(io.input) ? io.input.isRaw : false;
  if (isTTYReadStream(io.input)) {
    io.input.setRawMode(true);
  }

  io.input.resume();
  io.error.write("Attached. Press Ctrl-] to detach locally.\n");

  await new Promise<void>((resolve) => {
    let resolved = false;
    let finish = () => undefined;

    const onData = (chunk: Buffer | string) => {
      const data = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      if (data === "\u001d") {
        finish();
        return;
      }
      client.sendTerminalInput(stream, data);
    };

    const onResize = () => {
      client.resizeTerminal(stream, terminalCols(io.output), terminalRows(io.output));
    };

    finish = () => {
      if (resolved) {
        return;
      }
      resolved = true;
      io.input.off("data", onData);
      process.off("SIGWINCH", onResize);
      unsubscribeOutput();
      unsubscribeError();
      if (isTTYReadStream(io.input)) {
        io.input.setRawMode(wasRaw);
      }
      resolve();
    };

    io.input.on("data", onData);
    process.on("SIGWINCH", onResize);
    client.resizeTerminal(stream, cols, rows);
  });
}

function terminalCols(output: NodeJS.WriteStream): number {
  return isTTYWriteStream(output) && output.columns ? output.columns : 120;
}

function terminalRows(output: NodeJS.WriteStream): number {
  return isTTYWriteStream(output) && output.rows ? output.rows : 40;
}

function isTTYReadStream(input: NodeJS.ReadStream): input is ReadStream {
  return "isTTY" in input && Boolean(input.isTTY) && "setRawMode" in input;
}

function isTTYWriteStream(output: NodeJS.WriteStream): output is WriteStream {
  return "isTTY" in output && Boolean(output.isTTY);
}
