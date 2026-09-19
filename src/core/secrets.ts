const SECRET_COMMAND_NAME = /(?:^|[|;&]\s*)(?:printenv|env)\b/i;
const SECRET_COMMAND_SUBJECT =
  /\.env\b|\b(?:secrets?|credentials?|password|token|keychain|netrc|id_rsa|private[_-]?key)\b/i;
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const SECRET_ASSIGNMENT =
  /\b(?:aws_secret_access_key|api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[=:]\s*\S/i;
const URL_CREDENTIALS = /:\/\/[^\s:@/]+:[^\s:@/]+@/;

export function looksSecret(command: string, output: string): boolean {
  if (SECRET_COMMAND_NAME.test(command) || SECRET_COMMAND_SUBJECT.test(command)) return true;
  return PRIVATE_KEY_BLOCK.test(output) || SECRET_ASSIGNMENT.test(output) || URL_CREDENTIALS.test(output);
}
