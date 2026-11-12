// 에이전트가 호출하는 두 개의 도구: get_weather, find_spot
// - 모두 API 키가 필요 없는 공개 API 사용 (Nominatim, Open-Meteo, Overpass/OpenStreetMap)
const UA = "day4-weather-agent/0.1 (educational project)";

const WX_API = "https://api.open-meteo.com/v1/forecast";
const AQ_API = "https://air-quality-api.open-meteo.com/v1/air-quality";
const NOMINATIM = "https://nominatim.openstreetmap.org/search";
// 공개 Overpass 서버는 간헐적으로 느려서 여러 미러에 동시에 요청하고 먼저 온 응답을 쓴다
const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

const WMO = {
  0: "맑음", 1: "대체로 맑음", 2: "구름 조금", 3: "흐림", 45: "안개", 48: "서리 안개",
  51: "약한 이슬비", 53: "이슬비", 55: "강한 이슬비", 61: "약한 비", 63: "비", 65: "강한 비",
  71: "약한 눈", 73: "눈", 75: "강한 눈", 80: "소나기", 81: "강한 소나기", 82: "매우 강한 소나기",
  95: "뇌우", 96: "우박 동반 뇌우", 99: "강한 우박 동반 뇌우",
};
const GRADE_LABELS = ["좋음", "보통", "나쁨", "매우나쁨"];
const LIMITS = { pm10: [30, 80, 150], pm25: [15, 35, 75] };
function grade(kind, v) {
  if (v == null) return null;
  const i = LIMITS[kind].findIndex((l) => v <= l);
  return GRADE_LABELS[i < 0 ? 3 : i];
}

async function fetchJson(url, { timeoutMs = 9000, ...opts } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 위치 → 좌표 ----------
const geoCache = new Map();
async function geocode(location) {
  const q = String(location || "").trim().slice(0, 100);
  if (!q) throw new Error("location 이 비어 있습니다");
  const key = q.toLowerCase();
  if (geoCache.has(key)) return geoCache.get(key);
  const params = new URLSearchParams({
    q, format: "jsonv2", limit: "1", countrycodes: "kr", "accept-language": "ko",
  });
  const rows = await fetchJson(`${NOMINATIM}?${params}`, { headers: { "User-Agent": UA } });
  if (!rows.length) throw new Error(`'${q}' 위치를 찾지 못했습니다. 더 구체적인 지명(예: 강릉, 제주시)으로 시도하세요.`);
  const g = { lat: +rows[0].lat, lon: +rows[0].lon, name: rows[0].name || q };
  geoCache.set(key, g);
  return g;
}

function distKm(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dx = (lon2 - lon1) * rad * Math.cos(((lat1 + lat2) / 2) * rad);
  const dy = (lat2 - lat1) * rad;
  return 6371 * Math.sqrt(dx * dx + dy * dy);
}

// ---------- Tool 1: get_weather ----------
async function getWeather({ location }) {
  const g = await geocode(location);
  const base = { latitude: g.lat, longitude: g.lon, timezone: "Asia/Seoul" };
  const [w, a] = await Promise.all([
    fetchJson(`${WX_API}?${new URLSearchParams({
      ...base,
      current: "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m",
      daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
      forecast_days: "3",
    })}`),
    fetchJson(`${AQ_API}?${new URLSearchParams({ ...base, current: "pm10,pm2_5" })}`).catch(() => null),
  ]);
  const c = w.current;
  const d = w.daily;
  return {
    location: g.name,
    latitude: g.lat,
    longitude: g.lon,
    current: {
      time: c.time,
      condition: WMO[c.weather_code] ?? "알 수 없음",
      temperature_c: c.temperature_2m,
      feels_like_c: c.apparent_temperature,
      humidity_pct: c.relative_humidity_2m,
      wind_kmh: c.wind_speed_10m,
      precipitation_mm: c.precipitation,
    },
    air_quality: a
      ? {
          pm10: a.current.pm10, pm10_grade: grade("pm10", a.current.pm10),
          pm25: a.current.pm2_5, pm25_grade: grade("pm25", a.current.pm2_5),
          note: "대기질 모델 예측값(측정소 실측과 다를 수 있음)",
        }
      : null,
    forecast: d.time.map((date, i) => ({
      date,
      condition: WMO[d.weather_code[i]] ?? "알 수 없음",
      min_c: d.temperature_2m_min[i],
      max_c: d.temperature_2m_max[i],
      rain_probability_pct: d.precipitation_probability_max[i],
    })),
  };
}

// ---------- Tool 2: find_spot ----------
const CATEGORIES = {
  attraction: { label: "관광지", word: "관광", filter: '["tourism"~"^(attraction|museum|gallery|viewpoint|theme_park|zoo|aquarium)$"]', tags: ["tourism:attraction", "tourism:viewpoint", "tourism:theme_park"] },
  cafe: { label: "카페", word: "카페", filter: '["amenity"="cafe"]', tags: ["amenity:cafe"] },
  restaurant: { label: "맛집", word: "식당", filter: '["amenity"="restaurant"]', tags: ["amenity:restaurant"] },
  park: { label: "공원", word: "공원", filter: '["leisure"~"^(park|garden|nature_reserve)$"]', tags: ["leisure:park", "leisure:garden"] },
  museum: { label: "박물관·미술관", word: "박물관", filter: '["tourism"~"^(museum|gallery)$"]', tags: ["tourism:museum", "tourism:gallery"] },
  beach: { label: "해변", word: "해변", filter: '["natural"="beach"]', tags: ["natural:beach"] },
  viewpoint: { label: "전망대", word: "전망대", filter: '["tourism"="viewpoint"]', tags: ["tourism:viewpoint"] },
};
const PHOTON = "https://photon.komoot.io/api/";

function tagAddress(t) {
  return t["addr:full"] || [t["addr:city"], t["addr:district"], t["addr:street"], t["addr:housenumber"]].filter(Boolean).join(" ") || null;
}

async function overpassSpots(g, cat, radiusM, keyword) {
  const kw = keyword ? `["name"~"${keyword.replace(/["\\]/g, "")}",i]` : "";
  const query = `[out:json][timeout:12];(nwr${CATEGORIES[cat].filter}["name"]${kw}(around:${radiusM},${g.lat},${g.lon}););out center 60;`;
  const data = await Promise.any(
    OVERPASS.map((url) =>
      fetchJson(url, {
        method: "POST",
        headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ data: query }),
        timeoutMs: 6000,
      }).then((d) => {
        if (!Array.isArray(d.elements)) throw new Error("invalid overpass response");
        return d;
      })
    )
  );
  return data.elements
    .map((e) => {
      const t = e.tags || {};
      const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
      if (lat == null || lon == null) return null;
      const score = (t.wikidata ? 3 : 0) + (t.wikipedia ? 2 : 0) + (t.website ? 1 : 0) + (t.opening_hours ? 1 : 0) + (t["name:ko"] ? 1 : 0);
      return {
        name: t["name:ko"] || t.name,
        category: CATEGORIES[cat].label,
        lat, lon,
        distance_km: +distKm(g.lat, g.lon, lat, lon).toFixed(1),
        address: tagAddress(t),
        opening_hours: t.opening_hours || null,
        website: t.website || null,
        _score: score,
      };
    })
    .filter(Boolean);
}

// Photon(OSM 기반 검색): 위치 이름 + 태그 필터. Overpass 가 느릴 때의 대체 수단
async function photonSpots(g, cat, keyword, location) {
  // 위치 이름만, 위치 + 카테고리 단어(예: "강릉 카페") 두 가지 검색어로 조회해 결과를 늘린다
  const queries = keyword
    ? [`${location} ${keyword}`]
    : [location, `${location} ${CATEGORIES[cat].word}`];
  const jobs = [];
  for (const q of queries) {
    for (const tag of CATEGORIES[cat].tags) {
      jobs.push(
        fetchJson(`${PHOTON}?${new URLSearchParams({ q, lat: String(g.lat), lon: String(g.lon), limit: "10", osm_tag: tag })}`, {
          headers: { "User-Agent": UA }, timeoutMs: 8000,
        })
      );
    }
  }
  const lists = await Promise.allSettled(jobs);
  const out = [];
  for (const l of lists) {
    if (l.status !== "fulfilled") continue;
    for (const f of l.value.features || []) {
      const p = f.properties || {};
      if (p.countrycode && p.countrycode !== "KR") continue;
      const [lon, lat] = f.geometry.coordinates;
      out.push({
        name: p.name,
        category: CATEGORIES[cat].label,
        lat, lon,
        distance_km: +distKm(g.lat, g.lon, lat, lon).toFixed(1),
        address: [p.state, p.city || p.county, p.district, p.street, p.housenumber].filter(Boolean).join(" ") || null,
        opening_hours: null, website: null, _score: 0,
      });
    }
  }
  return out.filter((s) => s.name);
}

async function nominatimSpots(g, cat, keyword, location) {
  const params = new URLSearchParams({
    q: `${keyword || CATEGORIES[cat].label} ${location}`,
    format: "jsonv2", limit: "10", countrycodes: "kr", "accept-language": "ko", addressdetails: "0",
  });
  const rows = await fetchJson(`${NOMINATIM}?${params}`, { headers: { "User-Agent": UA } });
  return rows.map((r) => ({
    name: r.name || r.display_name.split(",")[0],
    category: CATEGORIES[cat].label,
    lat: +r.lat, lon: +r.lon,
    distance_km: +distKm(g.lat, g.lon, +r.lat, +r.lon).toFixed(1),
    address: r.display_name,
    opening_hours: null, website: null, _score: 0,
  }));
}

async function findSpot({ location, category = "attraction", keyword, radius_km = 8, limit = 6 }) {
  const g = await geocode(location);
  const cat = CATEGORIES[category] ? category : "attraction";
  const radiusM = Math.min(Math.max(Number(radius_km) || 8, 1), 25) * 1000;
  const max = Math.min(Math.max(Number(limit) || 6, 1), 8);
  const kw = keyword ? String(keyword).slice(0, 30) : "";

  // 1) Overpass → 2) Photon → 3) Nominatim 순서로 시도 (앞선 소스가 비거나 실패하면 다음으로)
  // Overpass 와 Photon 을 동시에 시작하고, Overpass 가 3초 안에 결과를 주면 그것을, 아니면 Photon 을 쓴다.
  const inRadius = (list) => list.filter((s) => s.distance_km <= radiusM / 1000);
  const op = overpassSpots(g, cat, radiusM, kw).then(inRadius).catch(() => []);
  const ph = photonSpots(g, cat, kw, location).then(inRadius).catch(() => []);
  let spots = [];
  let source = "overpass";
  const fast = await Promise.race([op, new Promise((r) => setTimeout(() => r(null), 3000))]);
  if (fast?.length) {
    spots = fast;
  } else {
    const p = await ph;
    if (p.length) { spots = p; source = "photon"; }
    else {
      spots = await op; // Photon 도 비면 Overpass 응답을 끝까지 기다림 (최대 6초)
      if (!spots.length) {
        source = "nominatim";
        spots = await nominatimSpots(g, cat, kw, location).then(inRadius).catch(() => []);
      }
    }
  }

  const seen = new Set();
  const result = spots
    .sort((a, b) => b._score - a._score || a.distance_km - b.distance_km)
    .filter((s) => (seen.has(s.name) ? false : seen.add(s.name)))
    .slice(0, max)
    .map(({ _score, ...s }) => s);

  return {
    location, center: { lat: g.lat, lon: g.lon }, category: CATEGORIES[cat].label, source,
    count: result.length, spots: result,
    ...(result.length ? {} : { note: "검색 결과가 없습니다. 다른 category/keyword 나 더 넓은 radius_km 로 다시 시도해 보세요." }),
  };
}

// ---------- Gemini function declarations ----------
const declarations = [
  {
    name: "get_weather",
    description:
      "한국 내 특정 지역의 실시간 날씨(기온·체감온도·습도·풍속·강수량), 미세먼지(PM10, PM2.5)와 앞으로 3일 예보를 조회한다. " +
      "나들이·여행 장소를 추천하기 전에 날씨와 미세먼지를 확인할 때, 또는 사용자가 날씨를 물을 때 사용한다.",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: "지역 이름 (예: 강릉, 제주시, 서울 강남구)" },
      },
      required: ["location"],
    },
  },
  {
    name: "find_spot",
    description:
      "한국 내 특정 지역 주변의 장소(관광지, 카페, 맛집, 공원, 박물관·미술관, 해변, 전망대)를 검색한다. " +
      "사용자가 갈 만한 곳·먹을 곳·할 거리를 추천해 달라고 할 때 사용한다.",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: "검색 중심 지역 (예: 강릉, 서울 성수동)" },
        category: {
          type: "string",
          enum: Object.keys(CATEGORIES),
          description: "장소 종류. attraction=관광지, cafe=카페, restaurant=맛집, park=공원, museum=박물관·미술관, beach=해변, viewpoint=전망대. 실내 활동이 필요하면 museum/cafe 등을 선택",
        },
        keyword: { type: "string", description: "장소 이름에 포함될 키워드 (선택). 예: 한옥, 커피" },
        radius_km: { type: "number", description: "검색 반경 km (기본 8, 최대 25)" },
        limit: { type: "integer", description: "결과 개수 (기본 6, 최대 8)" },
      },
      required: ["location", "category"],
    },
  },
];

const handlers = { get_weather: getWeather, find_spot: findSpot };

async function runTool(name, args) {
  const fn = handlers[name];
  if (!fn) throw new Error(`알 수 없는 도구: ${name}`);
  return fn(args || {});
}

module.exports = { declarations, runTool, geocode, getWeather, findSpot };
