import { errorCode } from "./errors.js";

export interface CliIo {
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly stdin: NodeJS.ReadableStream;
  write(text: string): Promise<void>;
  writeBytes(bytes: Buffer): Promise<void>;
  writeError(text: string): Promise<void>;
}

export const CLOSED_PIPE_CODES: ReadonlySet<string> = new Set([
  "EPIPE",
  "EOF",
  "ERR_STREAM_DESTROYED",
  "ERR_STREAM_WRITE_AFTER_END",
]);

export function processIo(): CliIo {
  const write = openWriter(process.stdout);
  return {
    env: process.env,
    cwd: process.cwd(),
    stdin: process.stdin,
    write: (text) => write(text),
    writeBytes: (bytes) => write(bytes),
    writeError: openWriter(process.stderr),
  };
}

export async function readStreamBytes(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
  }
  return Buffer.concat(chunks);
}

export async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  return (await readStreamBytes(stream)).toString("utf8");
}

export function isClosedPipe(error: unknown): boolean {
  const code = errorCode(error);
  return code !== undefined && CLOSED_PIPE_CODES.has(code);
}

function openWriter(stream: NodeJS.WriteStream): (chunk: string | Buffer) => Promise<void> {
  let closed = false;
  stream.on("error", (error: unknown) => {
    if (isClosedPipe(error)) closed = true;
  });
  return (chunk: string | Buffer) =>
    new Promise((resolve, reject) => {
      if (closed || chunk.length === 0) {
        resolve();
        return;
      }
      try {
        stream.write(chunk, (error) => {
          if (error === undefined || error === null) resolve();
          else if (isClosedPipe(error)) {
            closed = true;
            resolve();
          } else reject(error);
        });
      } catch (error) {
        if (!isClosedPipe(error)) {
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        closed = true;
        resolve();
      }
    });
}
