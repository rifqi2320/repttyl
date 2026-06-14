import readline from "node:readline/promises";
import type { Readable, Writable } from "node:stream";

export type SelectIO = {
  input: Readable;
  output: Writable;
};

export async function selectOne<T>(
  io: SelectIO,
  title: string,
  items: T[],
  render: (item: T, index: number) => string,
): Promise<T | undefined> {
  if (items.length === 0) {
    return undefined;
  }

  io.output.write(`\n${title}\n`);
  items.forEach((item, index) => {
    io.output.write(`  ${index + 1}. ${render(item, index)}\n`);
  });

  const rl = readline.createInterface({ input: io.input, output: io.output });
  try {
    for (;;) {
      const answer = (await rl.question("Select number, or q to quit: ")).trim();
      if (answer.toLowerCase() === "q") {
        return undefined;
      }

      const selected = Number.parseInt(answer, 10);
      if (Number.isInteger(selected) && selected >= 1 && selected <= items.length) {
        return items[selected - 1];
      }

      io.output.write(`Choose 1-${items.length}, or q.\n`);
    }
  } finally {
    rl.close();
  }
}

export async function promptText(io: SelectIO, prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: io.input, output: io.output });
  try {
    return (await rl.question(prompt)).trim();
  } finally {
    rl.close();
  }
}
