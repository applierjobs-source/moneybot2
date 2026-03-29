function createManualGate() {
  let resumeResolve = null;
  /** True if user clicked Resume before waitForResume ran (race). */
  let resumeRequested = false;
  /** True while automation is blocked inside waitForResume. */
  let awaiting = false;

  return {
    isAwaitingResume() {
      return awaiting;
    },
    async waitForResume() {
      if (resumeRequested) {
        resumeRequested = false;
        return;
      }
      awaiting = true;
      await new Promise((resolve) => {
        resumeResolve = resolve;
      });
      resumeResolve = null;
      awaiting = false;
      resumeRequested = false;
    },
    resume() {
      resumeRequested = true;
      if (resumeResolve) {
        resumeResolve();
        resumeResolve = null;
      }
      awaiting = false;
    },
    reset() {
      resumeRequested = false;
      resumeResolve = null;
      awaiting = false;
    },
  };
}

module.exports = { createManualGate };
