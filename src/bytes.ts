const LF = 0x0a;
const CR = 0x0d;

export function isValidUtf8(bytes: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export function byteLineStarts(bytes: Buffer): number[] {
  const starts: number[] = [0];
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];
    if (byte === CR && bytes[index + 1] === LF) index += 1;
    else if (byte !== CR && byte !== LF) continue;
    starts.push(index + 1);
  }
  if (starts[starts.length - 1] !== bytes.length) starts.push(bytes.length);
  return starts;
}

export function countByteLines(bytes: Buffer): number {
  return byteLineStarts(bytes).length - 1;
}
