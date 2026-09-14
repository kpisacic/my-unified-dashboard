(() => {
  "use strict";

  const LOCALE = navigator.language && navigator.language.startsWith("hr") ? "hr" : "en";
  const STATUS_POLL_MS = 20 * 1000;

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
    try {
      const res = await fetch("/api/status", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      renderContainers(data.containers || []);
    } catch (err) {
      console.error("Failed to fetch container status:", err);
      // Leave whatever was last rendered rather than wiping the row blank
      // on a single missed poll - the service being briefly unreachable
      // doesn't mean every container's own status is unknown.
    }
  }

  tickClock();
  setInterval(tickClock, 1000);
  pollStatus();
  setInterval(pollStatus, STATUS_POLL_MS);
})();
