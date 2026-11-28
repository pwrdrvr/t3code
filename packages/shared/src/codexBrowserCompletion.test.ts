import { describe, expect, it } from "vite-plus/test";

import {
  isPendingCodexBrowserCompletion,
  parseCodexBrowserCompletion,
} from "./codexBrowserCompletion.ts";

describe("codexBrowserCompletion", () => {
  it("parses standalone browser-complete directives with quoted titles and whitespace", () => {
    expect(
      parseCodexBrowserCompletion('::browser-complete{title="Verified recent OpenAI usage"}'),
    ).toEqual({ headline: "Verified recent OpenAI usage" });
    expect(
      parseCodexBrowserCompletion(
        '\n  ::browser-complete{title="Verified \\"quoted\\" \\\\ usage"}  \n',
      ),
    ).toEqual({ headline: 'Verified "quoted" \\ usage' });
    expect(
      parseCodexBrowserCompletion("::browser-complete{title='Paused for a sign-in code'}"),
    ).toEqual({ headline: "Paused for a sign-in code" });
    expect(
      parseCodexBrowserCompletion('::browser-complete{reason="auth" title="Paused for sign-in"}'),
    ).toEqual({ headline: "Paused for sign-in" });
  });

  it("buffers every nonempty prefix while streaming and rejects diverged text", () => {
    const marker = '::browser-complete{title="Verified recent OpenAI usage"}';
    for (const leading of ["", "  ", "\n", "\r\n  "]) {
      for (let length = 1; length <= marker.length; length += 1) {
        expect(isPendingCodexBrowserCompletion(`${leading}${marker.slice(0, length)}`)).toBe(true);
      }
      expect(isPendingCodexBrowserCompletion(`${leading}${marker}   \n`)).toBe(true);
    }

    for (const nonPending of [
      "Opening the usage page",
      '`::browser-complete{title="Verified"}`',
      '```\n::browser-complete{title="Verified"}\n```',
      'Use ::browser-complete{title="Verified"} after browsing.',
      '::browser-complete{title="Verified"} followed by prose',
      '::browser-complete{title="Verified"}\nNext paragraph',
      '::browser-complete{title="Verified"x',
      '::browser-complete{title="Verified"\n}',
      '::browser-complete{title="Line 1\nLine 2"}',
      "::browser-complete{}",
      '::browser-complete{title="   "}',
      '::browser-complete{other="value"}',
    ]) {
      expect(isPendingCodexBrowserCompletion(nonPending), nonPending).toBe(false);
      expect(parseCodexBrowserCompletion(nonPending), nonPending).toBeNull();
    }
  });
});
