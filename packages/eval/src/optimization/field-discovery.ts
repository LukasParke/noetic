import type { Step } from '@noetic-tools/core';
import { isServerToolSpec } from '@noetic-tools/core';

import { OptimizeScope } from '../types/eval';
import type { OptimizableField } from '../types/optimizer';
import { FieldKind } from '../types/optimizer';

//#region Types

type ScopeValue = (typeof OptimizeScope)[keyof typeof OptimizeScope];
type FieldKindValue = (typeof FieldKind)[keyof typeof FieldKind];

//#endregion

//#region Constants

const SCOPE_ALLOWED_KINDS: Record<ScopeValue, ReadonlySet<FieldKindValue>> = {
  [OptimizeScope.PromptsOnly]: new Set([
    FieldKind.Instructions,
    FieldKind.ToolDescription,
  ]),
  [OptimizeScope.FlowStructure]: new Set([
    FieldKind.Instructions,
    FieldKind.ToolDescription,
    FieldKind.ToolName,
  ]),
  [OptimizeScope.Full]: new Set([
    FieldKind.Instructions,
    FieldKind.ToolDescription,
    FieldKind.ToolName,
  ]),
};

//#endregion

//#region Helper Functions

function extractLlmFields(
  step: Step & {
    kind: 'llm';
  },
  path: string,
  fields: OptimizableField[],
): void {
  // Function-form Lazy<T> fields resolve at execution time against a live
  // context; they cannot be optimized by static candidate substitution.
  if (typeof step.instructions === 'string') {
    fields.push({
      path: `${path}.instructions`,
      value: step.instructions,
      stepId: step.id,
      fieldKind: FieldKind.Instructions,
    });
  }
  if (!Array.isArray(step.tools)) {
    return;
  }
  /* Tool fields are keyed by array INDEX, not by name. The name is itself an
   * optimizable field: keying by it meant a candidate that renamed a tool
   * invalidated every other candidate key for that tool on the next
   * applyCandidate pass (lookup by new name, keys built from old name), and
   * two tools could collide if the teacher renamed one onto the other. The
   * index is stable for the lifetime of an optimization run. */
  step.tools.forEach((t, i) => {
    // Server tools (web_search/web_fetch) carry no optimizable name/description.
    if (isServerToolSpec(t)) {
      return;
    }
    fields.push({
      path: `${path}.tools.${i}.description`,
      value: t.description,
      stepId: step.id,
      fieldKind: FieldKind.ToolDescription,
    });
    fields.push({
      path: `${path}.tools.${i}.name`,
      value: t.name,
      stepId: step.id,
      fieldKind: FieldKind.ToolName,
    });
  });
}

function extractToolFields(
  step: Step & {
    kind: 'tool';
  },
  path: string,
  fields: OptimizableField[],
): void {
  fields.push({
    path: `${path}.tool.description`,
    value: step.tool.description,
    stepId: step.id,
    fieldKind: FieldKind.ToolDescription,
  });
  fields.push({
    path: `${path}.tool.name`,
    value: step.tool.name,
    stepId: step.id,
    fieldKind: FieldKind.ToolName,
  });
}

function walkOptimizableChildren(
  optimizable: Step[] | undefined,
  path: string,
  fields: OptimizableField[],
): void {
  if (!optimizable) {
    return;
  }
  for (const child of optimizable) {
    walkStep(child, `${path}.`, fields);
  }
}

function walkStep(step: Step, prefix: string, fields: OptimizableField[]): void {
  const path = `${prefix}${step.id}`;

  switch (step.kind) {
    case 'llm':
      extractLlmFields(step, path, fields);
      return;
    case 'tool':
      extractToolFields(step, path, fields);
      return;
    case 'spawn':
      walkStep(step.child, `${path}.`, fields);
      return;
    case 'loop':
      for (const s of step.steps) {
        walkStep(s, `${path}.`, fields);
      }
      return;
    case 'provide':
      /* `provide` was missing: its child subtree was invisible to discovery
       * while `applyCandidate` happily recursed into it, so every prompt
       * under a provide() wrapper was silently excluded from optimization. */
      walkStep(step.child, `${path}.`, fields);
      return;
    case 'every':
      walkStep(step.step, `${path}.`, fields);
      return;
    case 'branch':
      walkOptimizableChildren(step._optimizable, path, fields);
      return;
    case 'fork':
      walkOptimizableChildren(step._optimizable, path, fields);
      return;
    // `run` holds no text fields. Sub-harness steps carry their prompt and
    // instructions as Lazy<string>, a surface the mutator does not model
    // (see mutator.ts) — discovering them would produce candidate keys that
    // applyCandidate ignores.
    case 'run':
    case 'claude-code':
    case 'codex':
    case 'opencode':
    case 'pi':
      return;
    default: {
      const exhaustive: never = step;
      void exhaustive;
      return;
    }
  }
}

function filterByScope(fields: OptimizableField[], scope: ScopeValue): OptimizableField[] {
  const allowed = SCOPE_ALLOWED_KINDS[scope];
  return fields.filter((f) => allowed.has(f.fieldKind));
}

//#endregion

//#region Public API

export function discoverFields(
  step: Step,
  prefix?: string,
  scope?: ScopeValue,
): OptimizableField[] {
  const fields: OptimizableField[] = [];
  const pathPrefix = prefix ? `${prefix}.` : '';
  walkStep(step, pathPrefix, fields);

  if (!scope) {
    return fields;
  }
  return filterByScope(fields, scope);
}

export function enrichWithSourceLocations(
  runtimeFields: OptimizableField[],
  astFields: OptimizableField[],
): OptimizableField[] {
  const astIndex = new Map<string, OptimizableField[]>();
  for (const af of astFields) {
    if (!af.sourceLocation) {
      continue;
    }
    const key = `${af.stepId}:${af.fieldKind}:${af.value}`;
    const existing = astIndex.get(key) ?? [];
    existing.push(af);
    astIndex.set(key, existing);
  }

  const consumed = new Set<OptimizableField>();

  return runtimeFields.map((rf) => {
    const candidates = astIndex.get(`${rf.stepId}:${rf.fieldKind}:${rf.value}`);
    if (!candidates) {
      return rf;
    }
    const match = candidates.find((c) => !consumed.has(c));
    if (!match?.sourceLocation) {
      return rf;
    }
    consumed.add(match);
    return {
      ...rf,
      sourceLocation: match.sourceLocation,
    };
  });
}

//#endregion
