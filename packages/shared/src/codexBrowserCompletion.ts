const BROWSER_COMPLETE_PREFIX = "::browser-complete{";
const MAX_BROWSER_COMPLETION_TITLE_LENGTH = 512;

export const BROWSER_USE_FALLBACK_TOOL_SOURCE = {
  key: "browser-use:browser",
  name: "Browser",
  kind: "browser",
} as const;

export interface CodexBrowserCompletion {
  readonly headline: string;
}

type BrowserCompletionScanResult =
  | { readonly state: "pending" }
  | { readonly state: "invalid" }
  | { readonly state: "complete"; readonly headline: string };

function isHorizontalWhitespace(char: string | undefined): boolean {
  return char === " " || char === "\t";
}

function isAttributeNameChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_.:-]/u.test(char);
}

function isInvalidUnquotedValueChar(char: string | undefined): boolean {
  return char === undefined || /[\s"'=<>`}]/u.test(char);
}

function scanBrowserCompletion(text: string): BrowserCompletionScanResult {
  const body = text.trimStart();
  if (body.length === 0) {
    return { state: "pending" };
  }
  if (BROWSER_COMPLETE_PREFIX.startsWith(body)) {
    return { state: "pending" };
  }
  if (!body.startsWith(BROWSER_COMPLETE_PREFIX)) {
    return { state: "invalid" };
  }

  let index = BROWSER_COMPLETE_PREFIX.length;
  let title: string | undefined;

  while (index < body.length) {
    while (isHorizontalWhitespace(body[index])) {
      index += 1;
    }
    if (index >= body.length) {
      return { state: "pending" };
    }
    const char = body[index];
    if (char === "\r" || char === "\n") {
      return { state: "invalid" };
    }
    if (char === "}") {
      index += 1;
      if (/\S/u.test(body.slice(index))) {
        return { state: "invalid" };
      }
      const headline = title?.trim();
      return headline && headline.length <= MAX_BROWSER_COMPLETION_TITLE_LENGTH
        ? { state: "complete", headline }
        : { state: "invalid" };
    }
    if (!isAttributeNameChar(char)) {
      return { state: "invalid" };
    }

    const nameStart = index;
    while (isAttributeNameChar(body[index])) {
      index += 1;
    }
    const name = body.slice(nameStart, index);

    const spaceStart = index;
    while (isHorizontalWhitespace(body[index])) {
      index += 1;
    }
    if (index >= body.length) {
      return { state: "pending" };
    }
    const afterName = body[index];
    if (afterName === "\r" || afterName === "\n") {
      return { state: "invalid" };
    }
    if (afterName === "}") {
      continue;
    }
    if (afterName !== "=") {
      if (index === spaceStart) {
        return { state: "invalid" };
      }
      continue;
    }

    index += 1;
    while (isHorizontalWhitespace(body[index])) {
      index += 1;
    }
    if (index >= body.length) {
      return { state: "pending" };
    }

    const valueStartChar = body[index];
    if (valueStartChar === "\r" || valueStartChar === "\n") {
      return { state: "invalid" };
    }

    let value = "";
    if (valueStartChar === '"' || valueStartChar === "'") {
      const quote = valueStartChar;
      index += 1;
      let closed = false;
      while (index < body.length) {
        const current = body[index]!;
        if (current === "\r" || current === "\n") {
          return { state: "invalid" };
        }
        if (current === "\\") {
          if (index + 1 >= body.length) {
            return { state: "pending" };
          }
          const escaped = body[index + 1]!;
          if (escaped === "\r" || escaped === "\n") {
            return { state: "invalid" };
          }
          value += escaped === quote || escaped === "\\" ? escaped : `\\${escaped}`;
          index += 2;
          continue;
        }
        if (current === quote) {
          index += 1;
          closed = true;
          break;
        }
        value += current;
        index += 1;
      }
      if (!closed) {
        return { state: "pending" };
      }
      if (index < body.length && !isHorizontalWhitespace(body[index]) && body[index] !== "}") {
        return { state: "invalid" };
      }
    } else {
      if (isInvalidUnquotedValueChar(valueStartChar)) {
        return { state: "invalid" };
      }
      const valueStart = index;
      while (index < body.length && !isInvalidUnquotedValueChar(body[index])) {
        index += 1;
      }
      value = body.slice(valueStart, index);
      if (index >= body.length) {
        return { state: "pending" };
      }
      if (!isHorizontalWhitespace(body[index]) && body[index] !== "}") {
        return { state: "invalid" };
      }
    }

    if (name === "title") {
      title = value;
    }
  }

  return { state: "pending" };
}

export function parseCodexBrowserCompletion(text: string): CodexBrowserCompletion | null {
  const result = scanBrowserCompletion(text);
  return result.state === "complete" ? { headline: result.headline } : null;
}

export function isPendingCodexBrowserCompletion(text: string): boolean {
  return scanBrowserCompletion(text).state !== "invalid";
}
