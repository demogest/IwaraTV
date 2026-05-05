export interface PlayerTemplateValues {
  url: string;
  title: string;
  headers: string;
}

export function splitTemplateArgs(template: string): string[] {
  const input = template.trim() || "{url}";
  const args: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;
  let escaped = false;

  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (quote) {
    throw new Error("外部播放器参数模板存在未闭合的引号。");
  }

  if (escaped) {
    current += "\\";
  }

  if (current) {
    args.push(current);
  }

  return args;
}

export function expandPlayerTemplateArg(arg: string, values: PlayerTemplateValues): string {
  return arg
    .replaceAll("{url}", values.url)
    .replaceAll("{title}", values.title)
    .replaceAll("{headers}", values.headers);
}

export function buildExternalPlayerArgs(template: string, values: PlayerTemplateValues): string[] {
  return splitTemplateArgs(template).map((arg) => expandPlayerTemplateArg(arg, values));
}

