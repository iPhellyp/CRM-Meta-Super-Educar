export function createWorkerHeartbeatLoop({
  record,
  intervalMs,
  onError = () => {},
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
}) {
  if (typeof record !== 'function') throw new TypeError('record deve ser uma função');
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new TypeError('intervalMs deve ser positivo');
  }

  let stopped = false;
  let inFlight = false;

  const beat = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      await record();
    } catch (error) {
      onError(error);
    } finally {
      inFlight = false;
    }
  };

  const timer = setIntervalImpl(() => {
    void beat();
  }, intervalMs);
  timer?.unref?.();

  return {
    beat,
    stop() {
      if (stopped) return;
      stopped = true;
      clearIntervalImpl(timer);
    },
  };
}
