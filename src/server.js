const path = require("path");
const express = require("express");

function createServer({ bus, manualGate, port }) {
  const app = express();

  app.use(express.json({ limit: "1mb" }));
  app.use(express.static(path.join(__dirname, "..", "public")));

  app.get("/healthz", (req, res) => res.status(200).json({ ok: true }));

  app.post("/resume", (req, res) => {
    manualGate.resume();
    bus.emit("event", { type: "MANUAL_RESUME" });
    res.json({ ok: true });
  });

  app.get("/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");

    // Flush headers so client starts receiving immediately.
    if (typeof res.flushHeaders === "function") res.flushHeaders();

    res.write(`data: ${JSON.stringify({ type: "CONNECTED" })}\n\n`);

    const onEvent = (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    bus.on("event", onEvent);
    req.on("close", () => {
      bus.off("event", onEvent);
    });
  });

  const server = app.listen(port, () => {
    // This log goes to terminal; UI will show streamed events.
    // eslint-disable-next-line no-console
    console.log(`Server listening on http://localhost:${port}`);
  });

  return server;
}

module.exports = { createServer };

