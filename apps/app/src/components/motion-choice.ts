/**
 * What moves, given the phone's Reduce Motion setting (`useReduceMotion`: true, false, or undefined until the phone has
 * said). Motion runs only once the phone has said it is off; while it is unknown or on, nothing slides.
 */

/** How a bottom sheet's modal appears: it slides only when motion is allowed, fades when reduced, is instant while unknown. */
export function modalAnimation(reduce: boolean | undefined): "slide" | "fade" | "none" {
  if (reduce === false) {
    return "slide";
  }
  return reduce === true ? "fade" : "none";
}

/** Whether a decorative or timing animation may run. */
export const mayAnimate = (reduce: boolean | undefined): boolean => reduce === false;

/**
 * How full an emptying timer bar is, 1 down to 0, after `elapsedMs` of `totalMs`. Animated, it follows the time
 * smoothly; otherwise it drops in steps of `stepMs` (whole seconds), so it still shows the time but nothing glides.
 */
export function timerFraction(
  elapsedMs: number,
  totalMs: number,
  animate: boolean,
  stepMs = 1000,
): number {
  if (totalMs <= 0) {
    return 0;
  }
  const clamped = Math.min(totalMs, Math.max(0, elapsedMs));
  const shown = animate ? clamped : Math.floor(clamped / stepMs) * stepMs;
  return 1 - shown / totalMs;
}
