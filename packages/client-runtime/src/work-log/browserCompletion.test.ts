import { describe, expect, it } from "@effect/vitest";
import {
  MessageId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  isStandaloneBrowserCompletionItem,
  normalizeBrowserCompletionTurnItems,
} from "./browserCompletion.ts";
import { summarizeToolGroup, type WorkLogPresentationEntry } from "./presentation.ts";
import { extractToolActivityPresentation } from "./toolPresentation.ts";

const THREAD_ID = ThreadId.make("thread-browser");
const RUN_ID = RunId.make("run-browser");
const NOW = DateTime.makeUnsafe("2026-11-26T10:00:00.000Z");

function row(item: OrchestrationV2TurnItem): OrchestrationV2ProjectedTurnItem {
  return {
    position: item.ordinal,
    visibility: "local",
    sourceThreadId: THREAD_ID,
    sourceItemId: item.id,
    item,
  };
}

function baseFields(id: string, ordinal: number) {
  return {
    id: TurnItemId.make(id),
    threadId: THREAD_ID,
    runId: RUN_ID,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: NOW,
    completedAt: NOW,
    updatedAt: NOW,
  };
}

function browserToolRow(id: string, ordinal: number): OrchestrationV2ProjectedTurnItem {
  return row({
    ...baseFields(id, ordinal),
    type: "dynamic_tool",
    toolName: "node_repl.js",
    title: "Inspect usage dashboard",
    toolSurface: "browser",
    toolIcon: { _tag: "website", pageUrl: "https://platform.openai.com/usage" },
    toolSource: { key: "browser-use:chrome", name: "Chrome", kind: "integration" },
    input: { title: "Inspect usage dashboard", code: "await page.title();" },
  });
}

function commentaryRow(
  id: string,
  ordinal: number,
  text: string,
  options: { streaming?: boolean; phase?: "commentary" | "final_answer" } = {},
): OrchestrationV2ProjectedTurnItem {
  const streaming = options.streaming ?? false;
  return row({
    ...baseFields(id, ordinal),
    status: streaming ? "running" : "completed",
    completedAt: streaming ? null : NOW,
    type: "assistant_message",
    phase: options.phase ?? "commentary",
    messageId: MessageId.make(`msg-${id}`),
    text,
    streaming,
  });
}

describe("normalizeBrowserCompletionTurnItems", () => {
  it("correlates settled commentary markers to the preceding browser activity across reasoning", () => {
    const reasoning = row({
      ...baseFields("reasoning-1", 2),
      type: "reasoning",
      text: "Summarizing the page state.",
      streaming: false,
    });
    const followUp = commentaryRow("after-1", 4, "Comparing with local logs.");
    const result = normalizeBrowserCompletionTurnItems([
      browserToolRow("browser-1", 1),
      reasoning,
      commentaryRow("complete-1", 3, '::browser-complete{title="Verified recent OpenAI usage"}'),
      followUp,
    ]);

    expect(result).toHaveLength(3);
    expect(result[0]?.item).toMatchObject({
      id: TurnItemId.make("browser-1"),
      type: "dynamic_tool",
      toolSurface: "browser",
      toolCompletionTitle: "Verified recent OpenAI usage",
    });
    expect(result[1]).toBe(reasoning);
    expect(result[2]).toBe(followUp);
  });

  it("projects standalone browser activity rows when matching browser metadata is unavailable", () => {
    const command = row({
      ...baseFields("cmd-1", 1),
      type: "command_execution",
      input: "ls",
    });
    const result = normalizeBrowserCompletionTurnItems([
      command,
      commentaryRow(
        "complete-standalone",
        2,
        '::browser-complete{title="Paused for a sign-in code"}',
      ),
    ]);

    expect(result).toHaveLength(2);
    expect(result[0]).toBe(command);
    const standalone = result[1]?.item;
    expect(standalone).toBeDefined();
    expect(isStandaloneBrowserCompletionItem(standalone!)).toBe(true);
    expect(standalone).toMatchObject({
      id: TurnItemId.make("complete-standalone"),
      type: "dynamic_tool",
      toolName: null,
      title: "Paused for a sign-in code",
      toolCompletionTitle: "Paused for a sign-in code",
      toolSurface: "browser",
      toolSource: { key: "browser-use:browser", name: "Browser", kind: "browser" },
      input: null,
    });
    expect(extractToolActivityPresentation(standalone)).toMatchObject({
      toolSurface: "browser",
      toolCompletionTitle: "Paused for a sign-in code",
    });
  });

  it("withholds partial streaming markers while preserving prose and literal examples", () => {
    const partial = commentaryRow("stream-1", 1, '::browser-complete{title="Verified', {
      streaming: true,
    });
    expect(normalizeBrowserCompletionTurnItems([partial])).toEqual([]);

    const literalFinal = commentaryRow(
      "final-1",
      2,
      '::browser-complete{title="Verified recent OpenAI usage"}',
      { phase: "final_answer" },
    );
    const literalInlineCode = commentaryRow(
      "code-1",
      3,
      '`::browser-complete{title="Verified recent OpenAI usage"}`',
    );
    const prose = commentaryRow(
      "prose-1",
      4,
      '::browser-complete{title="Verified"} is emitted after browsing.',
    );
    const input = [literalFinal, literalInlineCode, prose];
    expect(normalizeBrowserCompletionTurnItems(input)).toBe(input);
  });
});

describe("summarizeToolGroup with browser completion headlines", () => {
  it("uses the completion headline instead of generic browser integration copy", () => {
    const entries: WorkLogPresentationEntry[] = [
      {
        id: "b1",
        createdAt: "2026-11-26T10:00:00.000Z",
        label: "Open usage dashboard",
        tone: "tool",
        itemType: "dynamic_tool",
        toolLifecycleStatus: "completed",
        toolSurface: "browser",
        toolSource: { key: "browser-use:chrome", name: "Chrome", kind: "integration" },
      },
      {
        id: "b2",
        createdAt: "2026-11-26T10:00:02.000Z",
        label: "Read usage table",
        tone: "tool",
        itemType: "dynamic_tool",
        toolLifecycleStatus: "completed",
        toolSurface: "browser",
        toolSource: { key: "browser-use:chrome", name: "Chrome", kind: "integration" },
        toolCompletionTitle: "Verified recent OpenAI usage",
      },
    ];
    expect(summarizeToolGroup(entries)).toEqual({
      summary: "Verified recent OpenAI usage",
      hasFailure: false,
    });
  });
});
