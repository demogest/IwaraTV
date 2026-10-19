// External-player argument templates. Placeholders: {url}, {title}, {headers}.

export interface PlayerTemplateValues {
  url: string;
  title: string;
  headers: string;
}

export const PLAYER_REFERER_HEADER = "Referer: https://www.iwara.tv/";

export class PlayerTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlayerTemplateError";
  }
}

/** Shell-like splitting with single/double quotes and backslash escapes. */
export function splitTemplateArgs(template: string): string[] {
  const input = template.trim() ? template.trim() : "{url}";
  const args: string[] = [];
  let current = "";
  let quote: string | undefined;
  let escaped = false;
  let tokenStarted = false;

  for (const ch of input) {
    if (escaped) {
      current += ch;
      escaped = false;
      tokenStarted = true;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = undefined;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (tokenStarted) {
        args.push(current);
        current = "";
        tokenStarted = false;
      }
      continue;
    }
    current += ch;
    tokenStarted = true;
  }

  if (quote) {
    throw new PlayerTemplateError("The external player argument template has an unclosed quote.");
  }
  if (escaped) {
    current += "\\";
    tokenStarted = true;
  }
  if (tokenStarted) {
    args.push(current);
  }

  return args;
}

/** Fills the placeholders in one pass, so text inside a title or URL is never expanded again. */
export function buildExternalPlayerArgs(template: string, values: PlayerTemplateValues): string[] {
  return splitTemplateArgs(template).map((arg) =>
    arg.replace(/\{(url|title|headers)\}/g, (_match, name: keyof PlayerTemplateValues) => values[name])
  );
}

export function templateIncludesUrl(template: string): boolean {
  return splitTemplateArgs(template).some((arg) => arg.includes("{url}"));
}
