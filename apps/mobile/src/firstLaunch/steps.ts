/** Steps of the standard flow after the welcome screen (spec "Standard flow"). */
export const FLOW_STEPS = ['profile', 'lock', 'location', 'import'] as const;
export type FlowStep = (typeof FLOW_STEPS)[number];

/** [n, total] for "Step n of total". */
export function stepOf(step: FlowStep): [number, number] {
  return [FLOW_STEPS.indexOf(step) + 1, FLOW_STEPS.length];
}
