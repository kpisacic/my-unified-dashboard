(() => {
  "use strict";

  // Ported from Eko Karta Zagreb - standalone/app/static/app.js. Wrapped in
  // an IIFE (the original was a bare top-level script) so its helpers don't
  // collide with dhmz.js/pollen.js. Ids are prefixed (eko-*) and API calls
  // go through the dashboard's nginx proxy (/api/eko/*).

  const STORAGE_KEY = "eko-karta-station-id";

  const ICONS = {
    thermometer: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <rect x="10.4" y="3.5" width="3.2" height="12" rx="1.6"/>
      <circle cx="12" cy="17.5" r="3" fill="currentColor" fill-opacity="0.18"/>
      <line x1="12" y1="6" x2="12" y2="15" stroke-width="1.4"/>
      <line x1="15.2" y1="7" x2="16.6" y2="7"/>
      <line x1="15.2" y1="10" x2="16.6" y2="10"/>
    </svg>`,
    humidity: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 3.5c3 4 6 7.4 6 10.8a6 6 0 1 1-12 0c0-3.4 3-6.8 6-10.8Z" fill="currentColor" fill-opacity="0.12"/>
    </svg>`,
    pressure: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <path d="M4 15a8 8 0 1 1 16 0"/>
      <line x1="12" y1="15" x2="15.5" y2="10.5"/>
      <circle cx="12" cy="15" r="1.2" fill="currentColor" stroke="none"/>
      <line x1="4" y1="15" x2="2.5" y2="15"/>
      <line x1="20" y1="15" x2="21.5" y2="15"/>
    </svg>`,
    aqi: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <path d="M4 8.5h11a3 3 0 1 0-2.6-4.5"/>
      <path d="M4 12.5h14.5a3 3 0 1 1-2.7 4.3"/>
      <path d="M4 16.5h8"/>
    </svg>`,
    diatomic: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
      <line x1="8" y1="15.5" x2="16" y2="8.5"/>
      <circle cx="8" cy="15.5" r="3.1" fill="currentColor" fill-opacity="0.22"/>
      <circle cx="16" cy="8.5" r="3.1" fill="currentColor" fill-opacity="0.4"/>
    </svg>`,
    triatomic: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
      <line x1="6.5" y1="16" x2="12" y2="9.5"/>
      <line x1="12" y1="9.5" x2="17.5" y2="16"/>
      <circle cx="6.5" cy="16" r="2.6" fill="currentColor" fill-opacity="0.3"/>
      <circle cx="12" cy="9.5" r="2.9" fill="currentColor" fill-opacity="0.4"/>
      <circle cx="17.5" cy="16" r="2.6" fill="currentColor" fill-opacity="0.3"/>
    </svg>`,
    pm: `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none">
      <circle cx="7" cy="8" r="1.6"/>
      <circle cx="13" cy="6" r="1.1"/>
      <circle cx="17" cy="10" r="2"/>
      <circle cx="8" cy="15" r="2.2"/>
      <circle cx="15" cy="16" r="1.4"/>
      <circle cx="18" cy="17.5" r="0.9"/>
    </svg>`,
    refresh: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M20 11a8 8 0 1 0-2.3 5.7"/>
      <polyline points="20 5 20 11 14 11"/>
    </svg>`,
  };

  // Backend "icon" keys -> actual glyph. Several pollutants share a shape
  // (diatomic / triatomic molecule) and are told apart by label + accent color.
  const ICON_ALIASES = {
    co: "diatomic",
    no: "diatomic",
    no2: "triatomic",
    o3: "triatomic",
    so2: "triatomic",
  };

  function resolveIcon(key) {
    return ICONS[ICON_ALIASES[key] || key] || ICONS.aqi;
  }

  function aqBucket(index) {
    const n = Math.round(index);
    if (n <= 1) return 1;
    if (n >= 6) return 6;
    return n;
  }

  const refreshBtn = document.getElementById("eko-refresh-btn");
  refreshBtn.innerHTML = ICONS.refresh;

  const stationSelect = document.getElementById("eko-station-select");
  const statusLine = document.getElementById("eko-status-line");
  const errorBanner = document.getElementById("eko-error-banner");
  const metricsGrid = document.getElementById("eko-metrics");

  let refreshTimer = null;
  let currentStationId = null;
  let refreshIntervalSeconds = 300;

  async function fetchJSON(url) {
    const res = await fetch(url, { cache: "no-store" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(body.error || `Request failed (${res.status})`);
    }
    return body;
  }

  function showError(message) {
    errorBanner.textContent = message;
    errorBanner.hidden = false;
  }

  function clearError() {
    errorBanner.hidden = true;
    errorBanner.textContent = "";
  }

  function formatRelativeTime(isoString) {
    if (!isoString) return "unknown";
    const then = new Date(isoString).getTime();
    if (Number.isNaN(then)) return "unknown";
    const diffSeconds = Math.round((Date.now() - then) / 1000);
    if (diffSeconds < 45) return "just now";
    const diffMinutes = Math.round(diffSeconds / 60);
    if (diffMinutes < 60) return `${diffMinutes} min ago`;
    const diffHours = Math.round(diffMinutes / 60);
    if (diffHours < 48) return `${diffHours} h ago`;
    const diffDays = Math.round(diffHours / 24);
    return `${diffDays} d ago`;
  }

  function renderMetrics(payload) {
    metricsGrid.innerHTML = "";
    for (const metric of payload.metrics) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "metric";
      btn.style.setProperty("--metric-color", `var(--c-${metric.key}, var(--text-muted))`);

      const hasValue = metric.value !== null && metric.value !== undefined;
      const titleParts = [metric.label];
      if (hasValue) titleParts.push(`${metric.value}${metric.unit ? " " + metric.unit : ""}`);
      if (metric.index !== undefined && metric.index !== null) titleParts.push(`index ${metric.index}`);
      if (payload.updated) titleParts.push(`updated ${formatRelativeTime(payload.updated)}`);
      btn.title = titleParts.join(" — ");

      let indexBadge = "";
      if (metric.index !== undefined && metric.index !== null) {
        const bucket = aqBucket(metric.index);
        indexBadge = `<span class="metric-index" style="--idx-color: var(--aq-${bucket})">${metric.index}</span>`;
      } else if (metric.key === "aqi" && hasValue) {
        const bucket = aqBucket(metric.value);
        indexBadge = `<span class="metric-index" style="--idx-color: var(--aq-${bucket})">${metric.value}</span>`;
      }
      if (indexBadge) btn.classList.add("has-index");

      btn.innerHTML = `
        ${indexBadge}
        <span class="metric-main">
          <span class="metric-icon">${resolveIcon(metric.key)}</span>
          <span class="metric-value ${hasValue ? "" : "is-empty"}">${hasValue ? metric.value : "–"}${
            /* non-breaking space: never wrap value from unit - a wrapped
               row made just that one card taller than its neighbors. If a
               corner index badge leaves no room, .metric-value just clips
               (see eko.css) instead. */
            hasValue && metric.unit ? ` <span class="metric-unit">${metric.unit}</span>` : ""
          }</span>
        </span>
        <span class="metric-label">${metric.label}</span>
      `;
      metricsGrid.appendChild(btn);
    }
  }

  const STATION_OFFLINE_HOURS = 3;

  function isOutdated(isoString) {
    if (!isoString) return true;
    const then = new Date(isoString).getTime();
    if (Number.isNaN(then)) return true;
    return (Date.now() - then) / 3_600_000 > STATION_OFFLINE_HOURS;
  }

  function updateStatusLine(payload) {
    const relative = formatRelativeTime(payload.updated);
    const outdated = isOutdated(payload.updated);
    if (payload.stale) {
      statusLine.textContent = `${payload.station.name} — showing last known data (${relative})`;
    } else if (outdated) {
      statusLine.textContent = `${payload.station.name} — no recent readings (last one ${relative})`;
    } else {
      statusLine.textContent = `${payload.station.name} — updated ${relative}`;
    }
    statusLine.classList.toggle("stale", !!payload.stale || outdated);
  }

  async function loadStations(selectedId) {
    const stations = await fetchJSON("/api/eko/stations");
    stationSelect.innerHTML = "";

    let found = false;
    for (const station of stations) {
      const opt = document.createElement("option");
      opt.value = station.id;
      opt.textContent = station.name;
      if (station.id === selectedId) {
        opt.selected = true;
        found = true;
      }
      stationSelect.appendChild(opt);
    }

    if (!found && selectedId) {
      const opt = document.createElement("option");
      opt.value = selectedId;
      opt.textContent = `Station ${selectedId}`;
      opt.selected = true;
      stationSelect.prepend(opt);
    }
  }

  async function loadData(stationId, { spin = false } = {}) {
    if (spin) refreshBtn.classList.add("spinning");
    try {
      const payload = await fetchJSON(`/api/eko/data/${encodeURIComponent(stationId)}`);
      clearError();
      renderMetrics(payload);
      updateStatusLine(payload);
    } catch (err) {
      showError(`Could not load data: ${err.message}`);
      statusLine.textContent = "Update failed";
    } finally {
      if (spin) refreshBtn.classList.remove("spinning");
    }
  }

  function scheduleAutoRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      if (currentStationId) loadData(currentStationId);
    }, Math.max(refreshIntervalSeconds, 30) * 1000);
  }

  function selectStation(stationId, { persist = true } = {}) {
    currentStationId = stationId;
    if (persist) {
      try {
        localStorage.setItem(STORAGE_KEY, stationId);
      } catch (err) {
        /* localStorage unavailable (private mode etc.) - not fatal */
      }
    }
    statusLine.textContent = "Loading…";
    loadData(stationId);
  }

  async function init() {
    let storedId = null;
    try {
      storedId = localStorage.getItem(STORAGE_KEY);
    } catch (err) {
      /* ignore */
    }

    try {
      const config = await fetchJSON("/api/eko/config");
      refreshIntervalSeconds = config.refresh_interval_seconds || 300;
      currentStationId = storedId || config.default_station_id;
    } catch (err) {
      currentStationId = storedId || "969";
      showError(`Could not load configuration: ${err.message}`);
    }

    try {
      await loadStations(currentStationId);
    } catch (err) {
      showError(`Could not load station list: ${err.message}`);
    }

    stationSelect.addEventListener("change", () => {
      selectStation(stationSelect.value);
    });

    refreshBtn.addEventListener("click", () => {
      if (currentStationId) loadData(currentStationId, { spin: true });
    });

    if (currentStationId) {
      loadData(currentStationId);
    }
    scheduleAutoRefresh();
  }

  init();
})();
