// 전국 날씨 + 미세먼지 지도 (Open-Meteo Forecast + Air Quality, API 키 불필요)
const WX_API = "https://api.open-meteo.com/v1/forecast";
const AQ_API = "https://air-quality-api.open-meteo.com/v1/air-quality";
const REFRESH_MS = 10 * 60 * 1000;

// 지도에 한눈에 보여줄 전국 주요 도시
const OVERVIEW = ["서울","인천","수원","춘천","원주","강릉","속초","청주","천안","대전","세종","전주","광주","목포","여수",
  "안동","대구","포항","울산","부산","창원","진주","제주","울릉"];

// WMO weather code -> [아이콘, 설명]
const WMO = {
  0: ["☀️", "맑음"], 1: ["🌤️", "대체로 맑음"], 2: ["⛅", "구름 조금"], 3: ["☁️", "흐림"],
  45: ["🌫️", "안개"], 48: ["🌫️", "서리 안개"],
  51: ["🌦️", "약한 이슬비"], 53: ["🌦️", "이슬비"], 55: ["🌦️", "강한 이슬비"],
  61: ["🌧️", "약한 비"], 63: ["🌧️", "비"], 65: ["🌧️", "강한 비"],
  71: ["🌨️", "약한 눈"], 73: ["🌨️", "눈"], 75: ["❄️", "강한 눈"],
  80: ["🌦️", "소나기"], 81: ["🌧️", "강한 소나기"], 82: ["⛈️", "매우 강한 소나기"],
  95: ["⛈️", "뇌우"], 96: ["⛈️", "우박 동반 뇌우"], 99: ["⛈️", "강한 우박 동반 뇌우"],
};
const wmo = (code) => WMO[code] ?? ["❓", "알 수 없음"];

// 한국 환경부 기준 등급 (μg/m³)
const GRADES = [
  { label: "좋음", color: "#2f80ed" },
  { label: "보통", color: "#27ae60" },
  { label: "나쁨", color: "#f2994a" },
  { label: "매우나쁨", color: "#eb5757" },
];
const LIMITS = { pm10: [30, 80, 150], pm25: [15, 35, 75] };
function grade(kind, v) {
  if (v == null) return null;
  const i = LIMITS[kind].findIndex((l) => v <= l);
  return GRADES[i < 0 ? 3 : i];
}
const TEMP_STEPS = [
  { max: 0, label: "0°↓", color: "#2f80ed" },
  { max: 10, label: "~10°", color: "#56ccf2" },
  { max: 20, label: "~20°", color: "#27ae60" },
  { max: 28, label: "~28°", color: "#f2994a" },
  { max: Infinity, label: "28°↑", color: "#eb5757" },
];
const tempColor = (t) => TEMP_STEPS.find((s) => t <= s.max).color;

const $ = (id) => document.getElementById(id);
const NA = "-";

// ---------- API ----------
async function getJson(url, params) {
  const res = await fetch(`${url}?${new URLSearchParams(params)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** 여러 지점의 현재 날씨 + 미세먼지를 한 번에 조회 */
async function fetchCurrent(points) {
  const base = {
    latitude: points.map((p) => p.lat).join(","),
    longitude: points.map((p) => p.lon).join(","),
    timezone: "Asia/Seoul",
  };
  const [w, a] = await Promise.all([
    getJson(WX_API, {
      ...base,
      current: "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m",
    }),
    getJson(AQ_API, { ...base, current: "pm10,pm2_5" }).catch(() => null), // 미세먼지 실패해도 날씨는 표시
  ]);
  const wa = [].concat(w);
  const aa = a ? [].concat(a) : [];
  return points.map((place, i) => ({
    place,
    w: wa[i].current,
    wu: wa[i].current_units,
    a: aa[i]?.current ?? null,
  }));
}

// ---------- 지도 ----------
const map = L.map("map", { zoomControl: false }).setView([36.2, 127.8], 7);
L.control.zoom({ position: "bottomright" }).addTo(map);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 18,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · <a href="https://open-meteo.com">Open-Meteo</a>',
}).addTo(map);

const pinLayer = L.layerGroup().addTo(map);
let selectedRing = null;
let overview = [];     // fetchCurrent 결과
let layer = "pm10";

function pinInfo(d) {
  if (layer === "temp") {
    const t = d.w.temperature_2m;
    return { color: tempColor(t), text: `${Math.round(t)}°` };
  }
  const v = layer === "pm10" ? d.a?.pm10 : d.a?.pm2_5;
  const g = grade(layer, v);
  return { color: g?.color ?? "#999", text: v == null ? NA : Math.round(v) };
}

function renderPins() {
  pinLayer.clearLayers();
  for (const d of overview) {
    const { color, text } = pinInfo(d);
    const el = document.createElement("div");
    el.className = "pin";
    el.style.background = color;
    const name = document.createElement("small");
    name.textContent = d.place.name;
    const val = document.createElement("span");
    val.textContent = `${wmo(d.w.weather_code)[0]} ${text}`;
    el.append(name, val);
    const icon = L.divIcon({ html: el, className: "pin-wrap", iconSize: [0, 0] });
    L.marker([d.place.lat, d.place.lon], { icon })
      .on("click", () => selectPlace(d.place))
      .addTo(pinLayer);
  }
  renderLegend();
}

function renderLegend() {
  const items = layer === "temp"
    ? TEMP_STEPS.map((s) => ({ label: s.label, color: s.color }))
    : GRADES.map((g, i) => {
        const lim = LIMITS[layer];
        const range = i === 0 ? `≤${lim[0]}` : i === 3 ? `>${lim[2]}` : `≤${lim[i]}`;
        return { label: `${g.label} ${range}`, color: g.color };
      });
  $("legend").replaceChildren(...items.map((it) => {
    const span = document.createElement("span");
    const dot = document.createElement("i");
    dot.style.background = it.color;
    span.append(dot, it.label);
    return span;
  }));
}

async function loadOverview() {
  const points = OVERVIEW.map((n) => CITIES.find((c) => c[0] === n))
    .filter(Boolean)
    .map(([name, en, region, lat, lon]) => ({ name, en, region, lat, lon }));
  try {
    overview = await fetchCurrent(points);
    renderPins();
  } catch (err) {
    setStatus(`전국 현황을 불러오지 못했습니다: ${err.message}`, true);
  }
}

document.querySelectorAll(".layers button").forEach((b) =>
  b.addEventListener("click", () => {
    layer = b.dataset.layer;
    document.querySelectorAll(".layers button").forEach((x) => x.classList.toggle("on", x === b));
    renderPins();
  })
);

// ---------- 선택 지역 상세 ----------
let place = null;
let loadToken = 0;

function setStatus(msg, isError = false) {
  const s = $("status");
  s.className = isError ? "status error" : "status";
  s.textContent = msg;
  s.hidden = !msg;
}

function setBadgeText(el, kind, v, unit) {
  el.replaceChildren(v == null ? NA : `${Math.round(v)} ${unit}`);
  const g = grade(kind, v);
  if (g) {
    const b = document.createElement("span");
    b.className = "badge";
    b.style.background = g.color;
    b.textContent = g.label;
    el.append(b);
  }
}

async function loadDetail() {
  if (!place) return;
  const token = ++loadToken;
  setStatus(`${place.name} 불러오는 중...`);
  try {
    const [d] = await fetchCurrent([place]);
    if (token !== loadToken) return; // 더 최신 요청이 있으면 무시
    const [icon, desc] = wmo(d.w.weather_code);
    $("icon").textContent = icon;
    $("temp").textContent = Math.round(d.w.temperature_2m);
    $("desc").textContent = `${place.name} · ${desc}`;
    $("region").textContent = place.region || "";
    $("feels").textContent = `${d.w.apparent_temperature}${d.wu.apparent_temperature}`;
    $("humidity").textContent = `${d.w.relative_humidity_2m}${d.wu.relative_humidity_2m}`;
    $("wind").textContent = `${d.w.wind_speed_10m} ${d.wu.wind_speed_10m}`;
    $("precip").textContent = `${d.w.precipitation} ${d.wu.precipitation}`;
    setBadgeText($("pm10"), "pm10", d.a?.pm10, "μg/m³");
    setBadgeText($("pm25"), "pm25", d.a?.pm2_5, "μg/m³");
    $("time").textContent = d.w.time.replace("T", " ");
    $("weather").hidden = false;
    setStatus("");
  } catch (err) {
    if (token !== loadToken) return;
    $("weather").hidden = true;
    setStatus(`날씨를 가져오지 못했습니다: ${err.message}`, true);
  }
}

function selectPlace(p, { fly = true } = {}) {
  place = p;
  selectedRing?.remove();
  selectedRing = L.circleMarker([p.lat, p.lon], {
    radius: 18, color: "#1b2a3a", weight: 3, fillOpacity: 0, interactive: false,
  }).addTo(map);
  if (fly) map.flyTo([p.lat, p.lon], Math.max(map.getZoom(), 9), { duration: 0.8 });
  loadDetail();
}

// 지도 아무 곳이나 클릭 → 그 좌표의 날씨 (가까운 도시가 있으면 이름 표시)
function distKm(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dx = (lon2 - lon1) * rad * Math.cos(((lat1 + lat2) / 2) * rad);
  const dy = (lat2 - lat1) * rad;
  return 6371 * Math.sqrt(dx * dx + dy * dy);
}
map.on("click", (e) => {
  const { lat, lng: lon } = e.latlng;
  let best = null;
  for (const [ko, en, region, clat, clon] of CITIES) {
    const km = distKm(lat, lon, clat, clon);
    if (!best || km < best.km) best = { km, ko, region };
  }
  const near = best && best.km <= 25;
  selectPlace(
    {
      name: near ? `${best.ko} 부근` : "선택한 위치",
      region: near ? best.region : "",
      en: "",
      lat: +lat.toFixed(4),
      lon: +lon.toFixed(4),
    },
    { fly: false }
  );
});

// ---------- 자동완성 검색 ----------
const input = $("q");
const list = $("suggest");
let items = [];
let active = -1;
let timer = null;
let controller = null;

function closeList() {
  list.hidden = true;
  input.setAttribute("aria-expanded", "false");
  active = -1;
}

function renderList(msg) {
  list.replaceChildren();
  if (msg) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = msg;
    list.appendChild(li);
  }
  items.forEach((it, i) => {
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    li.className = i === active ? "active" : "";
    const strong = document.createElement("strong");
    strong.textContent = it.name;
    const sub = document.createElement("span");
    sub.textContent = [it.region, it.en].filter(Boolean).join(" · ");
    li.append(strong, sub);
    li.addEventListener("mousedown", (e) => { e.preventDefault(); choose(i); });
    list.appendChild(li);
  });
  list.hidden = false;
  input.setAttribute("aria-expanded", "true");
}

function choose(i) {
  input.value = items[i].name;
  closeList();
  selectPlace(items[i]);
}

input.addEventListener("input", () => {
  clearTimeout(timer);
  const q = input.value.trim();
  if (!q) { items = []; closeList(); return; }
  timer = setTimeout(async () => {
    controller?.abort();
    controller = new AbortController();
    try {
      items = await searchPlaces(q, controller.signal);
      active = items.length ? 0 : -1;
      renderList(items.length ? "" : "검색 결과가 없습니다");
    } catch (e) {
      if (e.name !== "AbortError") { items = []; renderList("검색 중 오류가 발생했습니다"); }
    }
  }, 200);
});

input.addEventListener("keydown", (e) => {
  if (list.hidden || !items.length) return;
  if (e.key === "ArrowDown") { active = (active + 1) % items.length; renderList(); e.preventDefault(); }
  else if (e.key === "ArrowUp") { active = (active - 1 + items.length) % items.length; renderList(); e.preventDefault(); }
  else if (e.key === "Enter" && active >= 0) { choose(active); e.preventDefault(); }
  else if (e.key === "Escape") closeList();
});
input.addEventListener("blur", closeList);

// ---------- 시작 ----------
$("refresh").addEventListener("click", () => { loadOverview(); loadDetail(); });
setInterval(() => { loadOverview(); loadDetail(); }, REFRESH_MS);

loadOverview();
const seoul = CITIES.find((c) => c[0] === "서울");
selectPlace({ name: seoul[0], en: seoul[1], region: seoul[2], lat: seoul[3], lon: seoul[4] }, { fly: false });
