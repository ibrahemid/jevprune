export const TAIL_RING_BYTES = 256 * 1024;

const LF = 0x0a;
const CR = 0x0d;

export interface CapturedOutput {
  readonly captured: Buffer;
  readonly bytes: number;
  readonly lines: number;
  readonly headSegmentLines: number;
  readonly oversize: boolean;
}

export class LineCounter {
  #terminators = 0;
  #pendingCr = false;
  #lastByte: number | undefined;

  push(chunk: Buffer): void {
    for (const byte of chunk) {
      if (this.#pendingCr) {
        this.#pendingCr = false;
        this.#terminators += 1;
        if (byte === LF) {
          this.#lastByte = byte;
          continue;
        }
      }
      if (byte === CR) {
        this.#pendingCr = true;
        this.#lastByte = byte;
        continue;
      }
      if (byte === LF) this.#terminators += 1;
      this.#lastByte = byte;
    }
  }

  get terminators(): number {
    return this.#terminators + (this.#pendingCr ? 1 : 0);
  }

  get lines(): number {
    if (this.#lastByte === undefined) return 0;
    const endsWithTerminator = this.#lastByte === LF || this.#lastByte === CR;
    return this.terminators + (endsWithTerminator ? 0 : 1);
  }
}

export class CaptureBuffer {
  readonly #maxBytes: number;
  readonly #head: Buffer[] = [];
  readonly #ring: Buffer[] = [];
  readonly #headCounter = new LineCounter();
  #headBytes = 0;
  #ringBytes = 0;
  #oversize = false;

  constructor(maxBytes: number) {
    this.#maxBytes = maxBytes;
  }

  get oversize(): boolean {
    return this.#oversize;
  }

  get headSegmentLines(): number {
    return this.#oversize ? this.#headCounter.terminators : this.#headCounter.lines;
  }

  push(chunk: Buffer): void {
    let rest = chunk;
    if (!this.#oversize) {
      const room = this.#maxBytes - this.#headBytes;
      if (rest.length <= room) {
        this.#head.push(rest);
        this.#headCounter.push(rest);
        this.#headBytes += rest.length;
        return;
      }
      if (room > 0) {
        const head = rest.subarray(0, room);
        this.#head.push(head);
        this.#headCounter.push(head);
        this.#headBytes += room;
        rest = rest.subarray(room);
      }
      this.#oversize = true;
    }
    this.#ring.push(rest);
    this.#ringBytes += rest.length;
    this.#trimRing();
  }

  bytes(): Buffer {
    if (!this.#oversize) {
      const single = this.#head.length === 1 ? this.#head[0] : undefined;
      return single ?? Buffer.concat(this.#head);
    }
    const head = trimToLastTerminator(Buffer.concat(this.#head));
    const tail = trimToFirstLine(Buffer.concat(this.#ring));
    return Buffer.concat([head, tail]);
  }

  #trimRing(): void {
    while (this.#ringBytes > TAIL_RING_BYTES) {
      const first = this.#ring[0];
      if (first === undefined) return;
      const excess = this.#ringBytes - TAIL_RING_BYTES;
      if (first.length <= excess) {
        this.#ring.shift();
        this.#ringBytes -= first.length;
      } else {
        this.#ring[0] = first.subarray(excess);
        this.#ringBytes -= excess;
      }
    }
  }
}

export class OutputCapture {
  readonly #buffer: CaptureBuffer;
  readonly #counter = new LineCounter();
  #bytes = 0;

  constructor(maxBytes: number) {
    this.#buffer = new CaptureBuffer(maxBytes);
  }

  push(chunk: Buffer): void {
    this.#bytes += chunk.length;
    this.#counter.push(chunk);
    this.#buffer.push(chunk);
  }

  result(): CapturedOutput {
    return {
      captured: this.#buffer.bytes(),
      bytes: this.#bytes,
      lines: this.#counter.lines,
      headSegmentLines: this.#buffer.headSegmentLines,
      oversize: this.#buffer.oversize,
    };
  }
}

export function captureBytes(bytes: Buffer, maxBytes: number): CapturedOutput {
  const capture = new OutputCapture(maxBytes);
  capture.push(bytes);
  return capture.result();
}

function trimToLastTerminator(buffer: Buffer): Buffer {
  for (let index = buffer.length - 1; index >= 0; index -= 1) {
    const byte = buffer[index];
    if (byte === LF || byte === CR) return buffer.subarray(0, index + 1);
  }
  return buffer.subarray(0, 0);
}

function trimToFirstLine(buffer: Buffer): Buffer {
  for (let index = 0; index < buffer.length; index += 1) {
    const byte = buffer[index];
    if (byte === LF) return buffer.subarray(index + 1);
    if (byte === CR) {
      const next = buffer[index + 1];
      return buffer.subarray(next === LF ? index + 2 : index + 1);
    }
  }
  return Buffer.alloc(0);
}
