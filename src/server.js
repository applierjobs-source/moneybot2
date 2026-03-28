const path = require("path");
const http = require("http");
const express = require("express");
const httpProxy = require("http-proxy");

function createServer({ bus, manualGate, port }) {
  const app = express();
  const vncEnabled = process.env.ENABLE_VNC === "true";

  app.use(express.json({ limit: "1mb" }));
  app.use(express.static(path.join(__dirname, "..", "public")));

  app.get("/healthz", (req, res) => res.status(200).json({ ok: true }));

  app.get("/vnc-status", (req, res) => {
    res.json({
      enabled: vncEnabled,
      viewerPath: vncEnabled
        ? "/novnc/vnc.html?autoconnect=true&resize=scale&reconnect=true&reconnect_delay=3000&path=novnc%2Fwebsockify"
        : null,
    });
  });

  app.post("/resume", (req, res) => {
    manualGate.resume();
    bus.emit("event", { type: "MANUAL_RESUME" });
    res.json({ ok: true });
  });

  app.get("/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");

    if (typeof res.flushHeaders === "function") res.flushHeaders();

    res.write(`data: ${JSON.stringify({ type: "CONNECTED" })}\n\n`);

    const onEvent = (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    bus.on("event", onEvent);
    // Comment lines keep some proxies (and Railway) from closing “idle” SSE connections.
    const heartbeat = setInterval(() => {
      try {
        res.write(`: ping ${Date.now()}\n\n`);
      } catch {
        clearInterval(heartbeat);
      }
    }, 20000);

    req.on("close", () => {
      clearInterval(heartbeat);
      bus.off("event", onEvent);
    });
  });

  let novncProxy;
  if (vncEnabled) {
    novncProxy = httpProxy.createProxyServer({
      target: "http://127.0.0.1:6080",
      changeOrigin: true,
    });
    // Express strips mount prefix: browser /novnc/vnc.html → req.url /vnc.html here
    app.use("/novnc", (req, res) => {
      novncProxy.web(req, res, (err) => {
        if (!res.headersSent) {
          res
            .status(502)
            .type("text/plain")
            .send("noVNC proxy error (is Xvfb/noVNC up on 6080? Check container logs.)");
        }
      });
    });
  }

  const server = http.createServer(app);

  if (vncEnabled && novncProxy) {
    server.on("upgrade", (req, socket, head) => {
      if (!req.url || !req.url.startsWith("/novnc/")) return;
      const stripped = req.url.slice("/novnc".length) || "/";
      req.url = stripped;
      novncProxy.ws(req, socket, head);
    });
  }

  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`Server listening on http://localhost:${port}${vncEnabled ? " (noVNC proxied at /novnc/)" : ""}`);
  });

  return server;
}

module.exports = { createServer };
