import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";

import { errorCode } from "./errors.js";

export const MISSING_KEY_MARKER = "missing-key-notice";

export async function shouldAnnounceMissingKey(home: string): Promise<boolean> {
  const path = join(home, MISSING_KEY_MARKER);
  try {
    await mkdir(home, { recursive: true, mode: 0o700 });
    const handle = await open(path, "wx", 0o600);
    await handle.close();
    return true;
  } catch (error) {
    return errorCode(error) !== "EEXIST";
  }
}
