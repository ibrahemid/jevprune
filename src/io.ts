export interface CliIo {
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly stdin: NodeJS.ReadableStream;
  write(text: string): Promise<void>;
  writeError(text: string): Promise<void>;
}

export function processIo(): CliIo {
  return {
    env: process.env,
    cwd: process.cwd(),
    stdin: process.stdin,
    write: (text) => writeTo(process.stdout, text),
    writeError: (text) => writeTo(process.stderr, text),
  };
}

export async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function writeTo(stream: NodeJS.WriteStream, text: string): Promise<void> {
  if (text.length === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    stream.write(text, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
