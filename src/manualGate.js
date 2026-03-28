function createManualGate() {
  let resumeResolve = null;
  let resumeRequested = false;

  return {
    async waitForResume() {
      if (resumeRequested) return;
      await new Promise((resolve) => {
        resumeResolve = resolve;
      });
    },
    resume() {
      resumeRequested = true;
      if (resumeResolve) resumeResolve();
    },
    reset() {
      resumeRequested = false;
      resumeResolve = null;
    },
  };
}

module.exports = { createManualGate };

