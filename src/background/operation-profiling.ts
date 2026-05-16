import type {
  LlmCostEstimate,
  LlmUsageMetrics,
  OperationProfilingSnapshot,
  OperationProfilingStage,
  OperationProfilingStageKey,
} from '../shared/types.js';

export interface OperationProfiler {
  readonly enabled: boolean;
  log(message: string): void;
  startStage(
    key: OperationProfilingStageKey,
    label: string,
    detail?: string,
  ): void;
  completeStage(key: OperationProfilingStageKey, detail?: string): void;
  failStage(key: OperationProfilingStageKey, detail?: string): void;
  skipStage(
    key: OperationProfilingStageKey,
    labelOrDetail?: string,
    detail?: string,
  ): void;
  setLlmUsage(usage: LlmUsageMetrics): void;
  setLlmCost(cost: LlmCostEstimate): void;
  setReasoningBlock(text: string): void;
  snapshot(): OperationProfilingSnapshot | undefined;
  finalizeRunningStages(detail?: string): OperationProfilingSnapshot | undefined;
}

function cloneStage(stage: OperationProfilingStage): OperationProfilingStage {
  return { ...stage };
}

function buildSnapshot(
  startMs: number,
  logEntries: OperationProfilingSnapshot['logEntries'],
  stages: OperationProfilingStage[],
  llmUsage?: LlmUsageMetrics,
  llmCost?: LlmCostEstimate,
  reasoningBlock?: string,
): OperationProfilingSnapshot {
  const activeStages = stages.filter((stage) => stage.status === 'running');
  const trimmedReasoningBlock = reasoningBlock?.trim();

  return {
    elapsedMs: Math.max(0, Date.now() - startMs),
    activeLabel:
      activeStages.length > 0
        ? activeStages.map((stage) => stage.label).join(' + ')
        : null,
    logEntries: logEntries.map((entry) => ({ ...entry })),
    stages: stages.map(cloneStage),
    ...(llmUsage ? { llmUsage: { ...llmUsage } } : {}),
    ...(llmCost ? { llmCost: { ...llmCost } } : {}),
    ...(trimmedReasoningBlock ? { reasoningBlock: trimmedReasoningBlock } : {}),
  };
}

export function createOperationProfiler(enabled: boolean): OperationProfiler {
  if (!enabled) {
    return {
      enabled: false,
      log: () => undefined,
      startStage: () => undefined,
      completeStage: () => undefined,
      failStage: () => undefined,
      skipStage: () => undefined,
      setLlmUsage: () => undefined,
      setLlmCost: () => undefined,
      setReasoningBlock: () => undefined,
      snapshot: () => undefined,
      finalizeRunningStages: () => undefined,
    };
  }

  const startMs = Date.now();
  const logEntries: OperationProfilingSnapshot['logEntries'] = [];
  const stages: OperationProfilingStage[] = [];
  const stageByKey = new Map<OperationProfilingStageKey, OperationProfilingStage>();
  let llmUsage: LlmUsageMetrics | undefined;
  let llmCost: LlmCostEstimate | undefined;
  let reasoningBlock: string | undefined;

  const elapsed = (): number => Math.max(0, Date.now() - startMs);

  const findStage = (key: OperationProfilingStageKey): OperationProfilingStage | undefined =>
    stageByKey.get(key);

  const endStage = (
    key: OperationProfilingStageKey,
    status: OperationProfilingStage['status'],
    detail?: string,
  ): void => {
    const stage = findStage(key);
    if (!stage || stage.status !== 'running') {
      return;
    }

    const endedElapsedMs = elapsed();
    stage.status = status;
    stage.endedElapsedMs = endedElapsedMs;
    stage.durationMs = Math.max(0, endedElapsedMs - stage.startedElapsedMs);
    if (detail !== undefined) {
      stage.detail = detail;
    }
  };

  return {
    enabled: true,
    log(message: string): void {
      logEntries.push({
        elapsedMs: elapsed(),
        message,
      });
    },
    startStage(
      key: OperationProfilingStageKey,
      label: string,
      detail?: string,
    ): void {
      if (findStage(key)) {
        return;
      }

      const stage: OperationProfilingStage = {
        key,
        label,
        status: 'running',
        startedElapsedMs: elapsed(),
        ...(detail !== undefined ? { detail } : {}),
      };
      stages.push(stage);
      stageByKey.set(key, stage);
    },
    completeStage(key: OperationProfilingStageKey, detail?: string): void {
      endStage(key, 'completed', detail);
    },
    failStage(key: OperationProfilingStageKey, detail?: string): void {
      endStage(key, 'failed', detail);
    },
    skipStage(
      key: OperationProfilingStageKey,
      labelOrDetail?: string,
      detail?: string,
    ): void {
      const existing = findStage(key);
      if (existing) {
        if (existing.status === 'running') {
          const endedElapsedMs = elapsed();
          existing.status = 'skipped';
          existing.endedElapsedMs = endedElapsedMs;
          existing.durationMs = Math.max(
            0,
            endedElapsedMs - existing.startedElapsedMs,
          );
        }
        if (detail !== undefined) {
          existing.detail = detail;
        } else if (labelOrDetail !== undefined && existing.detail === undefined) {
          existing.detail = labelOrDetail;
        }
        return;
      }

      const startedElapsedMs = elapsed();
      const label = detail !== undefined ? labelOrDetail ?? key : key;
      stages.push({
        key,
        label,
        status: 'skipped',
        startedElapsedMs,
        endedElapsedMs: startedElapsedMs,
        durationMs: 0,
        ...(detail !== undefined
          ? { detail }
          : labelOrDetail !== undefined
            ? { detail: labelOrDetail }
            : {}),
      });
      stageByKey.set(key, stages[stages.length - 1]!);
    },
    setLlmUsage(usage: LlmUsageMetrics): void {
      llmUsage = { ...usage };
    },
    setLlmCost(cost: LlmCostEstimate): void {
      llmCost = { ...cost };
    },
    setReasoningBlock(text: string): void {
      reasoningBlock = text;
    },
    snapshot(): OperationProfilingSnapshot | undefined {
      return buildSnapshot(
        startMs,
        logEntries,
        stages,
        llmUsage,
        llmCost,
        reasoningBlock,
      );
    },
    finalizeRunningStages(detail?: string): OperationProfilingSnapshot | undefined {
      for (const stage of stages) {
        if (stage.status !== 'running') {
          continue;
        }
        const endedElapsedMs = elapsed();
        stage.status = 'failed';
        stage.endedElapsedMs = endedElapsedMs;
        stage.durationMs = Math.max(0, endedElapsedMs - stage.startedElapsedMs);
        if (detail !== undefined) {
          stage.detail = detail;
        }
      }
      return buildSnapshot(
        startMs,
        logEntries,
        stages,
        llmUsage,
        llmCost,
        reasoningBlock,
      );
    },
  };
}
