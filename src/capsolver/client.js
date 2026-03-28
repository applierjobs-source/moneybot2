const CREATE_URL = "https://api.capsolver.com/createTask";
const RESULT_URL = "https://api.capsolver.com/getTaskResult";

async function capsolverPost(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Create a CapSolver task and poll until ready or failed.
 * @param {string} clientKey
 * @param {object} task
 * @param {{ emit: (e: { type: string, label: string }) => void }} [hooks]
 */
async function solveTask(clientKey, task, hooks) {
  const created = await capsolverPost(CREATE_URL, { clientKey, task });
  if (created.errorId) {
    throw new Error(created.errorDescription || created.errorCode || `CapSolver createTask errorId=${created.errorId}`);
  }
  const taskId = created.taskId;
  hooks?.emit?.({ type: "CAPSOLVER_CREATED", label: `${task.type} taskId=${taskId}` });

  for (let i = 0; i < 90; i++) {
    await sleep(1500);
    const res = await capsolverPost(RESULT_URL, { clientKey, taskId });
    if (res.errorId && res.errorId !== 0) {
      throw new Error(res.errorDescription || res.errorCode || `CapSolver getTaskResult errorId=${res.errorId}`);
    }
    if (res.status === "ready") return res.solution || {};
    if (res.status === "failed") throw new Error("CapSolver task failed");
  }
  throw new Error("CapSolver timeout waiting for solution");
}

module.exports = { solveTask, capsolverPost };
