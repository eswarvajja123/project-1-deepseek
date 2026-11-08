import type { MemoryGraphNode } from "@space/contracts";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";

/**
 * Bounded label selection for the 3D memory graph.
 *
 * The Canvas renderer measured and drew a label for every qualifying node each frame,
 * including a `measureText` call and a collision scan, so label cost grew with the
 * graph. This caps the work: labels are ranked once, then only the top `maxMeasured`
 * are measured, and at most `maxDrawn` are drawn after collision avoidance.
 *
 * Ranking keeps the renderer's existing intent: the focused node first, then core
 * labels, then sources, then the rest.
 */

export type LabelCandidate = {
  id: string;
  label: string;
  type: MemoryGraphNode["type"];
  x: number;
  y: number;
};

export type LabelBudget = {
  maxMeasured: number;
  maxDrawn: number;
};

export const DEFAULT_LABEL_BUDGET: LabelBudget = { maxMeasured: 64, maxDrawn: 48 };

export type LabelRequest = {
  candidates: readonly LabelCandidate[];
  focusId: string | null;
  showTitles: boolean;
  zoom: number;
  width: number;
  height: number;
  measure: (text: string) => number;
  budget?: LabelBudget;
};

export type SelectedLabel = { id: string; text: string; x: number; y: number; width: number };

export function selectMemoryLabels(request: LabelRequest): SelectedLabel[] {
  const { candidates, focusId, showTitles, zoom, width, height, measure } = request;
  const budget = request.budget ?? DEFAULT_LABEL_BUDGET;
  if (!showTitles) return [];

  const rank = (candidate: LabelCandidate) => {
    if (candidate.id === focusId) return 0;
    if (isMemoryCoreLabel(candidate.label)) return 1;
    return 2;
  };

  // Measure only as many as the budget allows; ranking is a cheap sort over ids.
  const ordered = [...candidates]
    .filter(candidate => candidate.type === "SOURCE" || candidate.id === focusId || zoom >= 1.6)
    .sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label))
    .slice(0, budget.maxMeasured);

  const boxes: Array<{ x: number; y: number; width: number }> = [];
  const selected: SelectedLabel[] = [];
  for (const candidate of ordered) {
    if (selected.length >= budget.maxDrawn) break;
    const text = candidate.label.length > 48 ? `${candidate.label.slice(0, 45)}…` : candidate.label;
    const x = candidate.x + 9;
    const y = candidate.y;
    const measured = measure(text);
    if (x + measured > width || y < 14 || y > height - 5) continue;
    // Collision avoidance against labels already accepted this frame.
    const collides = boxes.some(box => Math.abs(box.y - y) < 16 && x < box.x + box.width + 5 && x + measured + 5 > box.x);
    if (collides) continue;
    boxes.push({ x, y, width: measured });
    selected.push({ id: candidate.id, text, x, y, width: measured });
  }
  return selected;
}
