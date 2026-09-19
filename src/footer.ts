import { homedir } from "node:os";

import { displayPath as displayCorePath } from "./core/paths.js";
import { formatFooter as formatCoreFooter } from "./core/footer.js";
import type { FooterInput as CoreFooterInput } from "./core/footer.js";

export { footerAfter, formatCount, withFooter } from "./core/footer.js";
export type { FooterInput } from "./core/footer.js";

export function formatFooter(input: Omit<CoreFooterInput, "userHome">): string {
  return formatCoreFooter({ ...input, userHome: homedir() });
}

export function displayPath(path: string, home: string = homedir()): string {
  return displayCorePath(path, home);
}
