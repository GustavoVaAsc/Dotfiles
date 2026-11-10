// Debounced, serialized draft saving. Timer functions are injectable so tests need no real clock.

export function createAutosaver({ save, delay = 700, setTimer = setTimeout, clearTimer = clearTimeout, onStatus = () => {} }) {
  let timer = null;
  let pending = null;
  let hasPending = false;
  let inFlight = null;

  // One loop at a time: a change made while a save is running is saved right after it, never concurrently.
  function run() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        while (hasPending) {
          const payload = pending;
          hasPending = false;
          pending = null;
          onStatus('saving');
          try {
            await save(payload);
            onStatus('saved');
          } catch {
            if (!hasPending) {
              pending = payload; // keep it so the next flush or change retries
              hasPending = true;
            }
            onStatus('error');
            return;
          }
        }
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  return {
    schedule(payload) {
      pending = payload;
      hasPending = true;
      clearTimer(timer);
      timer = setTimer(() => {
        timer = null;
        return run();
      }, delay);
    },
    flush() {
      clearTimer(timer);
      timer = null;
      return run();
    },
    cancel() {
      clearTimer(timer);
      timer = null;
      pending = null;
      hasPending = false;
    },
    idle() {
      return inFlight ?? Promise.resolve();
    },
  };
}
