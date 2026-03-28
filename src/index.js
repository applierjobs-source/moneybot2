require("dotenv").config();

const { bus } = require("./bus");
const { createManualGate } = require("./manualGate");
const { createServer } = require("./server");
const { runMicroworkersAutomation } = require("./microworkers/automation");
const { loadConfigFromEnv } = require("./config");

async function main() {
  const cfg = loadConfigFromEnv();
  const manualGate = createManualGate();

  createServer({
    bus,
    manualGate,
    port: cfg.STREAM_PORT,
  });

  bus.emit("event", { type: "UI_READY", label: "Open dashboard in your browser and watch events." });

  try {
    await runMicroworkersAutomation({ bus, manualGate, cfg });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err);
    bus.emit("event", { type: "ERROR", label: `Fatal: ${err?.message || String(err)}` });
  }
}

main();

