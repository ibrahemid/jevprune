export function newRunId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(2));
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return `${Date.now().toString(36)}-${hex}`;
}
