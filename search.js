// 지역 검색: 내장 목록(즉시) + Open-Meteo Geocoding API(한글→로마자 변환 후 검색)
const GEO_API = "https://geocoding-api.open-meteo.com/v1/search";

const HANGUL_RE = /[가-힣ㄱ-ㅎ]/;
const CHOSEONG = ["ㄱ","ㄲ","ㄴ","ㄷ","ㄸ","ㄹ","ㅁ","ㅂ","ㅃ","ㅅ","ㅆ","ㅇ","ㅈ","ㅉ","ㅊ","ㅋ","ㅌ","ㅍ","ㅎ"];

// 국립국어원 로마자 표기법(음절 단위)
const R_INITIAL = ["g","kk","n","d","tt","r","m","b","pp","s","ss","","j","jj","ch","k","t","p","h"];
const R_MEDIAL = ["a","ae","ya","yae","eo","e","yeo","ye","o","wa","wae","oe","yo","u","wo","we","wi","yu","eu","ui","i"];
const R_FINAL = ["","k","k","k","n","n","n","t","l","k","m","l","l","l","p","l","m","p","p","t","t","ng","t","t","k","t","p","t"];

function decompose(ch) {
  const code = ch.charCodeAt(0) - 0xac00;
  if (code < 0 || code > 11171) return null;
  return { i: Math.floor(code / 588), m: Math.floor((code % 588) / 28), f: code % 28 };
}

/** 한글 → 영문 로마자 (예: 강릉 → Gangneung) */
function romanize(text) {
  const syl = [...text].map((c) => ({ c, d: decompose(c) }));
  let out = "";
  syl.forEach((s, idx) => {
    if (!s.d) { out += s.c; return; }
    let initial = R_INITIAL[s.d.i];
    const prev = idx > 0 ? syl[idx - 1].d : null;
    if (s.d.i === 5 && prev) {          // 초성 ㄹ 동화
      if (prev.f === 21) initial = "n";           // ㅇ+ㄹ → ng+n  (강릉)
      else if (prev.f === 8 || prev.f === 4) initial = "l"; // ㄹ/ㄴ+ㄹ → ll (신라)
    }
    let fin = R_FINAL[s.d.f];
    if (s.d.f === 4 && idx + 1 < syl.length && syl[idx + 1].d?.i === 5) fin = "l"; // ㄴ+ㄹ
    out += initial + R_MEDIAL[s.d.m] + fin;
  });
  return out;
}

/** 초성 문자열 (서울 → ㅅㅇ) */
function choseong(text) {
  return [...text].map((c) => { const d = decompose(c); return d ? CHOSEONG[d.i] : c; }).join("");
}

function searchLocal(q) {
  const lower = q.toLowerCase();
  const jamoOnly = /^[ㄱ-ㅎ]+$/.test(q);
  const scored = [];
  for (const [ko, en, region, lat, lon] of CITIES) {
    let score = -1;
    if (ko.startsWith(q) || en.toLowerCase().startsWith(lower)) score = 0;
    else if (jamoOnly && choseong(ko).startsWith(q)) score = 1;
    else if (q.length > 1 && (ko.includes(q) || region.includes(q))) score = 2;
    else if (q.length > 2 && en.toLowerCase().includes(lower)) score = 2;
    if (score >= 0) scored.push({ score, item: { name: ko, en, region, lat, lon } });
  }
  return scored.sort((a, b) => a.score - b.score).map((s) => s.item);
}

async function geocode(name, signal) {
  const params = new URLSearchParams({ name, count: "10", language: "ko", countryCode: "KR", format: "json" });
  const res = await fetch(`${GEO_API}?${params}`, { signal });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.results ?? [])
    .filter((r) => r.country_code === "KR")
    .sort((a, b) => (b.population ?? 0) - (a.population ?? 0))
    .map((r) => ({
      name: r.name,
      en: "",
      region: [r.admin1, r.admin2, r.admin3].filter((v) => v && v !== r.name).join(" "),
      lat: r.latitude,
      lon: r.longitude,
    }));
}

async function searchPlaces(raw, signal) {
  const q = raw.trim();
  if (!q) return [];
  const results = searchLocal(q);

  // API 검색어: 한글이면 로마자로 변환(시/군/구 접미사 제거), 영어면 그대로
  let remoteQuery = q;
  if (HANGUL_RE.test(q)) {
    if (/^[ㄱ-ㅎ]+$/.test(q)) return results.slice(0, 8);
    if (q.length < 2) return results.slice(0, 8); // 한 글자는 내장 목록만 (API 정확도 낮음)
    const base = q.length > 2 ? q.replace(/[시군구]$/, "") : q;
    remoteQuery = romanize(base);
  }
  if (remoteQuery.length >= 3 && results.length < 8) {
    try {
      let remote = await geocode(remoteQuery, signal);
      if (!remote.length && remoteQuery !== q) remote = await geocode(q, signal); // 변환 실패 시 원문
      for (const r of remote) {
        const dup = results.some(
          (l) => Math.abs(l.lat - r.lat) < 0.3 && Math.abs(l.lon - r.lon) < 0.3 &&
                 (r.name.includes(l.name) || l.name.includes(r.name))
        );
        if (!dup) results.push(r);
      }
    } catch (e) {
      if (e.name === "AbortError") throw e;
      /* 네트워크 오류 시 내장 목록 결과만 사용 */
    }
  }
  return results.slice(0, 8);
}
