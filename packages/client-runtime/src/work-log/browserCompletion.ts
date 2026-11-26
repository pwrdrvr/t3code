import type { OrchestrationV2ProjectedTurnItem, OrchestrationV2TurnItem } from "@t3tools/contracts";
import {
  BROWSER_USE_FALLBACK_TOOL_SOURCE,
  isPendingCodexBrowserCompletion,
  parseCodexBrowserCompletion,
} from "@t3tools/shared/codexBrowserCompletion";

export function isStandaloneBrowserCompletionItem(item: OrchestrationV2TurnItem): boolean {
  return (
    item.type === "dynamic_tool" &&
    item.toolName === null &&
    item.toolSurface === "browser" &&
    typeof item.toolCompletionTitle === "string" &&
    item.toolCompletionTitle.trim().length > 0
  );
}

export function isPotentialBrowserCompletionCommentary(item: OrchestrationV2TurnItem): boolean {
  if (item.type !== "assistant_message" || item.phase !== "commentary") {
    return false;
  }
  return item.streaming
    ? isPendingCodexBrowserCompletion(item.text)
    : parseCodexBrowserCompletion(item.text) !== null;
}

function toStandaloneBrowserCompletionItem(
  item: Extract<OrchestrationV2TurnItem, { readonly type: "assistant_message" }>,
  headline: string,
): Extract<OrchestrationV2TurnItem, { readonly type: "dynamic_tool" }> {
  return {
    id: item.id,
    threadId: item.threadId,
    runId: item.runId,
    nodeId: item.nodeId,
    providerThreadId: item.providerThreadId,
    providerTurnId: item.providerTurnId,
    nativeItemRef: item.nativeItemRef,
    parentItemId: item.parentItemId,
    ordinal: item.ordinal,
    status: "completed",
    title: headline,
    toolCompletionTitle: headline,
    toolSurface: "browser",
    toolSource: BROWSER_USE_FALLBACK_TOOL_SOURCE,
    startedAt: item.startedAt,
    completedAt: item.completedAt ?? item.updatedAt,
    updatedAt: item.updatedAt,
    type: "dynamic_tool",
    toolName: null,
    input: null,
  };
}

/**
 * Normalizes settled or streaming Codex `::browser-complete` commentary items in
 * projected turn items so replayed or persisted threads render identically to live turns.
 */
export function normalizeBrowserCompletionTurnItems(
  rows: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
): ReadonlyArray<OrchestrationV2ProjectedTurnItem> {
  if (!rows.some((row) => isPotentialBrowserCompletionCommentary(row.item))) {
    return rows;
  }

  const normalized: OrchestrationV2ProjectedTurnItem[] = [];
  let latestBrowserIndex: number | null = null;
  let latestBrowserScope: {
    readonly sourceThreadId: OrchestrationV2ProjectedTurnItem["sourceThreadId"];
    readonly runId: OrchestrationV2TurnItem["runId"];
  } | null = null;

  for (const row of rows) {
    const { item } = row;
    if (item.type === "reasoning") {
      normalized.push(row);
      continue;
    }

    if (item.type === "assistant_message" && item.phase === "commentary") {
      if (item.streaming && isPendingCodexBrowserCompletion(item.text)) {
        continue;
      }
      if (!item.streaming) {
        const completion = parseCodexBrowserCompletion(item.text);
        if (completion !== null) {
          if (
            latestBrowserIndex !== null &&
            latestBrowserScope !== null &&
            latestBrowserScope.sourceThreadId === row.sourceThreadId &&
            latestBrowserScope.runId === item.runId
          ) {
            const target = normalized[latestBrowserIndex]!;
            if (target.item.type === "dynamic_tool") {
              normalized[latestBrowserIndex] = {
                ...target,
                item: {
                  ...target.item,
                  toolCompletionTitle: completion.headline,
                },
              };
              continue;
            }
          }
          latestBrowserIndex = null;
          latestBrowserScope = null;
          normalized.push({
            ...row,
            item: toStandaloneBrowserCompletionItem(item, completion.headline),
          });
          continue;
        }
      }
      latestBrowserIndex = null;
      latestBrowserScope = null;
      normalized.push(row);
      continue;
    }

    if (
      item.type === "dynamic_tool" &&
      item.toolSurface === "browser" &&
      item.toolName !== null &&
      item.status !== "running" &&
      item.status !== "pending"
    ) {
      latestBrowserIndex = normalized.length;
      latestBrowserScope = { sourceThreadId: row.sourceThreadId, runId: item.runId };
      normalized.push(row);
      continue;
    }

    latestBrowserIndex = null;
    latestBrowserScope = null;
    normalized.push(row);
  }

  return normalized;
}
