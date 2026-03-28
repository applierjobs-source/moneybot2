# Railway-friendly container build for Playwright automation.
# Uses a Playwright image with Chromium dependencies.

FROM mcr.microsoft.com/playwright:v1.58.2-jammy

WORKDIR /app

ENV NODE_ENV=production
# Default: headless unless we enable VNC.
ENV BROWSER_HEADLESS=true
ENV ENABLE_VNC=false
ENV VNC_WEB_PORT=6080

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Ensure Chromium is available inside the container.
RUN npx playwright install chromium

RUN apt-get update && apt-get install -y --no-install-recommends \
  xvfb x11vnc websockify ca-certificates wget \
  && rm -rf /var/lib/apt/lists/*

# noVNC (VNC-to-Web)
RUN mkdir -p /opt/novnc && \
  wget -qO- https://github.com/novnc/noVNC/archive/refs/tags/v1.4.0.tar.gz | tar -xz --strip-components=1 -C /opt/novnc

EXPOSE 3000 6080

CMD ["bash", "src/start.sh"]

