(function () {
  "use strict";

  // Ported from Stampar Pelud - standalone/static/app.js. Ids are prefixed
  // (pollen-*) and API calls go through the dashboard's nginx proxy
  // (/api/pollen/*) instead of relative same-origin paths.

  const PREFS_KEY = "stampar_pelud_prefs";
  const DEFAULT_POLL_MS = 30 * 60 * 1000;

  const els = {
    title: document.getElementById("pollen-title"),
    subtitle: document.getElementById("pollen-subtitle"),
    status: document.getElementById("pollen-status"),
    grid: document.getElementById("pollen-grid"),
    stationSelect: document.getElementById("pollen-station-select"),
    iconStyle: document.getElementById("pollen-icon-style"),
    activeOnly: document.getElementById("pollen-active-only"),
    refreshBtn: document.getElementById("pollen-refresh-btn"),
  };

  function loadPrefs() {
    try {
      return JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
    } catch (e) {
      return {};
    }
  }

  function savePrefs(prefs) {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch (e) {
      /* ignore (private mode / storage disabled) */
    }
  }

  const prefs = loadPrefs();

  function levelSlug(level) {
    if (!level) return "unknown";
    return level.toLowerCase().replace(/\s+/g, "");
  }

  function iconPath(plant, style) {
    const known = plant.known;
    if (!plant.icon) {
      return null;
    }
    switch (style) {
      case "set1":
        return `icons/${plant.icon}.png`;
      case "set2":
        return `icons/${plant.icon}_transparent.png`;
      case "pictogram":
      default:
        return known ? `icons/${plant.icon}_0.svg` : `icons/${plant.icon}.svg`;
    }
  }

  function formatDate(dateStr) {
    // stampar.hr dates look like "26.03.2022." -> show "26.03"
    return (dateStr || "").split(".").slice(0, 2).join(".");
  }

  function renderCard(plant) {
    const style = els.iconStyle.value;
    const measurements = plant.measurements || [];
    const current = measurements[0];
    const forecast = measurements.slice(1);

    const level = current ? current.level : "";
    const slug = current ? levelSlug(level) : "unknown";
    const value = current && current.value ? current.value : (current ? level : "");

    const card = document.createElement("div");
    card.className = "card";

    const name = document.createElement("div");
    name.className = "card-name";
    name.textContent = plant.name;
    card.appendChild(name);

    const iconWrap = document.createElement("div");
    iconWrap.className = "card-icon";
    const src = iconPath(plant, style);
    if (src) {
      const img = document.createElement("img");
      img.src = src;
      img.alt = plant.name;
      if (style === "pictogram") {
        img.className = `icon-filter-${slug}`;
      }
      iconWrap.appendChild(img);
    }
    card.appendChild(iconWrap);

    const valueEl = document.createElement("div");
    valueEl.className = `card-value level-${slug}`;
    valueEl.textContent = current ? value : "";
    card.appendChild(valueEl);

    const levelEl = document.createElement("div");
    levelEl.className = `card-level level-${slug}`;
    levelEl.textContent = current && current.value ? level : "";
    card.appendChild(levelEl);

    const forecastEl = document.createElement("div");
    forecastEl.className = "card-forecast";
    forecast.forEach((m) => {
      const item = document.createElement("span");
      item.className = "forecast-item";
      const dot = document.createElement("span");
      dot.className = `dot level-${levelSlug(m.level)}`;
      item.appendChild(dot);
      item.appendChild(document.createTextNode(formatDate(m.date)));
      forecastEl.appendChild(item);
    });
    card.appendChild(forecastEl);

    return { card, known: plant.known };
  }

  function render(data) {
    els.title.textContent = `Peludna prognoza ${data.station_name || ""}`;
    const first = (data.plants || []).find((p) => p.measurements && p.measurements.length);
    const date = first ? formatDate(first.measurements[0].date) : "";
    const fetched = data.fetched_at ? new Date(data.fetched_at) : null;
    els.subtitle.textContent = [
      date ? `stanje za ${date}` : "",
      fetched ? `osvježeno ${fetched.toLocaleString("hr-HR")}` : "",
    ].filter(Boolean).join(" · ");

    els.grid.innerHTML = "";
    const activeOnly = els.activeOnly.checked;
    (data.plants || []).forEach((plant) => {
      const { card, known } = renderCard(plant);
      if (activeOnly && !known) return;
      els.grid.appendChild(card);
    });
  }

  function setStatus(text, isError) {
    els.status.textContent = text;
    els.status.classList.toggle("error", !!isError);
  }

  let currentData = null;

  function setStationInUrl(stationId) {
    const url = new URL(window.location.href);
    url.searchParams.set("station", stationId);
    window.history.replaceState({}, "", url);
  }

  async function loadStations() {
    const res = await fetch("/api/pollen/stations");
    const data = await res.json();
    const ids = Object.keys(data.stations).sort(
      (a, b) => data.stations[a].name.localeCompare(data.stations[b].name, "hr")
    );
    els.stationSelect.innerHTML = "";
    ids.forEach((id) => {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = data.stations[id].name;
      els.stationSelect.appendChild(opt);
    });
    const urlStation = new URL(window.location.href).searchParams.get("station");
    const wanted = urlStation || prefs.station || data.default;
    if (ids.includes(wanted)) {
      els.stationSelect.value = wanted;
    }
    return data;
  }

  const POLL_RETRY_MS = 1500;
  const POLL_MAX_ATTEMPTS = 20; // ~30s worst case while a first-time station is being scraped
  const REQUEST_TIMEOUT_MS = 8000;

  async function fetchWithTimeout(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(url, { signal: controller.signal });
    } catch (err) {
      if (err.name === "AbortError") {
        throw new Error("isteklo je vrijeme čekanja odgovora poslužitelja");
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async function loadPollen() {
    // The backend never blocks on the (slow, network-bound) stampar.hr fetch
    // itself: a station with no cached data yet answers with 202 "loading"
    // immediately, and we poll until it's ready. This keeps every request
    // fast and avoids a long-held connection that something in between
    // (a proxy, container networking, ...) could reset as "Failed to fetch".
    const station = els.stationSelect.value;
    setStatus("Dohvaćanje podataka...");
    try {
      for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
        if (els.stationSelect.value !== station) return; // superseded by a newer call
        const res = await fetchWithTimeout(`/api/pollen/pollen?station=${encodeURIComponent(station)}`);
        if (res.status === 202) {
          setStatus("Dohvaćanje podataka sa stampar.hr...");
          await new Promise((resolve) => setTimeout(resolve, POLL_RETRY_MS));
          continue;
        }
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        currentData = body;
        render(currentData);
        setStatus("");
        return;
      }
      throw new Error("poslužitelj predugo ne odgovara");
    } catch (err) {
      setStatus(`Greška: ${err.message}`, true);
    }
  }

  function applyPrefsToControls(serverConfig) {
    // A viewer's own choice (once made) always wins; until then, fall back
    // to the server-configured default (ICON_STYLE / ACTIVE_ONLY env vars).
    els.iconStyle.value = prefs.iconStyle || serverConfig.icon_style || "pictogram";
    els.activeOnly.checked =
      typeof prefs.activeOnly === "boolean" ? prefs.activeOnly : !!serverConfig.active_only;
  }

  els.stationSelect.addEventListener("change", () => {
    prefs.station = els.stationSelect.value;
    savePrefs(prefs);
    setStationInUrl(els.stationSelect.value);
    loadPollen();
  });

  els.iconStyle.addEventListener("change", () => {
    prefs.iconStyle = els.iconStyle.value;
    savePrefs(prefs);
    if (currentData) render(currentData);
  });

  els.activeOnly.addEventListener("change", () => {
    prefs.activeOnly = els.activeOnly.checked;
    savePrefs(prefs);
    if (currentData) render(currentData);
  });

  els.refreshBtn.addEventListener("click", () => loadPollen());

  (async function init() {
    const serverConfig = await loadStations();
    applyPrefsToControls(serverConfig);
    await loadPollen();
    setInterval(loadPollen, DEFAULT_POLL_MS);
  })();
})();
