export const ACTIVITY_SHIMMER_DURATION_MS = 1_000;
export const ACTIVITY_SHIMMER_INTERVAL_MS = 4_000;
export const ACTIVITY_SHIMMER_INITIAL_DELAY_MS = 600;

export function scheduleCadencedActivityShimmer(setActive: (active: boolean) => void): () => void {
  let stopped = false;
  let deactivateTimer: ReturnType<typeof setTimeout> | undefined;
  let cadenceInterval: ReturnType<typeof setInterval> | undefined;

  const deactivate = () => {
    if (deactivateTimer !== undefined) {
      clearTimeout(deactivateTimer);
      deactivateTimer = undefined;
    }
    setActive(false);
  };
  const pulse = () => {
    if (stopped) {
      return;
    }
    deactivate();
    setActive(true);
    deactivateTimer = setTimeout(deactivate, ACTIVITY_SHIMMER_DURATION_MS);
  };
  const initialTimer = setTimeout(() => {
    if (stopped) {
      return;
    }
    pulse();
    cadenceInterval = setInterval(pulse, ACTIVITY_SHIMMER_INTERVAL_MS);
  }, ACTIVITY_SHIMMER_INITIAL_DELAY_MS);

  return () => {
    if (stopped) {
      return;
    }
    stopped = true;
    clearTimeout(initialTimer);
    if (cadenceInterval !== undefined) {
      clearInterval(cadenceInterval);
      cadenceInterval = undefined;
    }
    deactivate();
  };
}
