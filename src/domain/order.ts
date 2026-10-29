const STEP = 1024

export function between(before: number | undefined, after: number | undefined): number {
  if (before === undefined && after === undefined) return STEP
  if (before === undefined) return (after as number) - STEP
  if (after === undefined) return before + STEP
  return (before + after) / 2
}
