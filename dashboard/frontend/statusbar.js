(() => {
  "use strict";

  const LOCALE = navigator.language && navigator.language.startsWith("hr") ? "hr" : "en";
  const STATUS_POLL_MS = 20 * 1000;

  // Must match the exact-match whitelist in nginx.conf's /docker-api/
  // location - nginx 404s anything not in that list regardless of what's
  // requested here.
  const MONITORED_CONTAINERS = ["dhmz-weather", "eko-karta-zagreb", "stampar-pelud", "wall-dashboard"];

  const els = {
    time: document.getElementById("statusbar-time"),
    day: document.getElementById("statusbar-day"),
    date: document.getElementById("statusbar-date"),
    containers: document.getElementById("statusbar-containers"),
  };

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function tickClock() {
    const now = new Date();
    els.time.textContent = `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
    els.day.textContent = now.toLocaleDateString(LOCALE, { weekday: "long" });
    els.date.textContent = `${pad2(now.getDate())}.${pad2(now.getMonth() + 1)}.${now.getFullYear()}`;
  }

  // Same state/health -> color mapping the old docker-status Python
  // service used - moved client-side now that nginx proxies the Docker
  // API's own inspect JSON straight through, unfiltered.
  function colorFor(state, health) {
    if (state === "running") {
      if (health === "unhealthy") return "light-green";
      if (health === "starting") return "yellow";
      return "green"; // "healthy", or no healthcheck configured at all
    }
    if (state === "restarting") return "yellow";
    if (state === "exited" || state === "dead" || state === "paused") return "red";
    return "gray"; // "created", not found, or unreachable
  }

  async function fetchContainerStatus(name) {
    try {
      const res = await fetch(`/docker-api/containers/${encodeURIComponent(name)}/json`, {
        cache: "no-store",
        headers: window.DOCKER_STATUS_AUTH ? { Authorization: window.DOCKER_STATUS_AUTH } : {},
      });
      if (!res.ok) return { name, state: null, health: null, color: "gray" };
      const info = await res.json();
      const state = info.State && info.State.Status;
      const health = info.State && info.State.Health && info.State.Health.Status;
      return { name, state: state || null, health: health || null, color: colorFor(state, health) };
    } catch (err) {
      return { name, state: null, health: null, color: "gray" };
    }
  }

  function renderContainers(containers) {
    els.containers.innerHTML = "";
    for (const c of containers) {
      const item = document.createElement("span");
      item.className = "statusbar-item";
      const stateLabel = c.health ? `${c.state} (${c.health})` : c.state || "unknown";
      item.title = `${c.name} — ${stateLabel}`;

      const dot = document.createElement("span");
      dot.className = `statusbar-dot color-${c.color}`;
      item.appendChild(dot);

      const label = document.createElement("span");
      label.textContent = c.name;
      item.appendChild(label);

      els.containers.appendChild(item);
    }
  }

  async function pollStatus() {
    // Independent per-container fetches now (vs. one aggregated call
    // before), so one container's request failing doesn't leave the
    // whole row stale - just that one dot goes gray.
    const results = await Promise.all(MONITORED_CONTAINERS.map(fetchContainerStatus));
    renderContainers(results);
  }

  tickClock();
  setInterval(tickClock, 1000);
  pollStatus();
  setInterval(pollStatus, STATUS_POLL_MS);
})();
