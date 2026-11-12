// Vercel 서버리스 함수: POST /api/chat
// 사용자 질문 → Gemini(function calling) → get_weather / find_spot 선택·실행 → 최종 추천 답변
// GEMINI_API_KEY 는 Vercel 환경변수에만 둔다 (브라우저로 노출되지 않음)
const { declarations, runTool } = require("./_lib/tools");

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const BASE = process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta";
const MAX_STEPS = 4;          // 도구 호출 왕복 최대 횟수
const MAX_MESSAGES = 12;      // 대화 기록 최대 개수
const MAX_TEXT = 800;         // 메시지 하나당 최대 글자 수

const SYSTEM = `당신은 한국 국내 여행·나들이를 추천하는 에이전트입니다. 한국어로 친절하고 간결하게 답하세요.

도구 사용 규칙:
- 장소·나들이·데이트·여행 추천 요청이면, 먼저 get_weather 로 해당 지역의 날씨와 미세먼지를 확인하고, find_spot 으로 실제 장소를 검색한 뒤 추천하세요. 두 도구는 독립적이므로 가능하면 함께 호출하세요.
- 날씨만 묻는 질문에는 get_weather 만 사용하세요.
- 비(강수확률 높음)가 오거나 미세먼지가 '나쁨' 이상이면 실내 장소(museum, cafe 등)를 우선 검색하세요. 맑고 좋은 날씨면 야외(park, beach, viewpoint, attraction)를 추천하세요.
- 도구 결과에 없는 장소·수치·영업시간은 지어내지 마세요. 검색 결과가 비면 조건을 바꿔 한 번 더 검색하세요.
- 지역이 불분명하면 먼저 어느 지역인지 되물으세요. 한국 밖 지역은 지원하지 않는다고 안내하세요.

답변 형식:
- 먼저 현재 날씨·미세먼지를 한 줄로 요약하고, 그에 맞춰 추천 장소를 최대 5곳, 각 장소마다 한 줄 이유를 쓰세요.
- 장소 이름은 도구 결과의 이름을 그대로 쓰세요.`;

function sanitizeMessages(raw) {
  if (!Array.isArray(raw)) return null;
  const msgs = raw
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.text === "string" && m.text.trim())
    .slice(-MAX_MESSAGES)
    .map((m) => ({ role: m.role, text: m.text.trim().slice(0, MAX_TEXT) }));
  while (msgs.length && msgs[0].role !== "user") msgs.shift(); // 첫 메시지는 user 여야 함
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") return null;
  return msgs;
}

async function callGemini(contents, key) {
  const res = await fetch(`${BASE}/models/${MODEL}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents,
      tools: [{ functionDeclarations: declarations }],
      toolConfig: { functionCallingConfig: { mode: "AUTO" } },
      generationConfig: { temperature: 0.6 },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`Gemini API 오류 (HTTP ${res.status})`);
    err.detail = body.slice(0, 300);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function describeStep(name, args, result) {
  if (result.error) return `${name} 실패: ${result.error}`;
  if (name === "get_weather") {
    return `get_weather(${args.location}) → ${result.current.condition} ${result.current.temperature_c}°C` +
      (result.air_quality?.pm10_grade ? `, 미세먼지 ${result.air_quality.pm10_grade}` : "");
  }
  if (name === "find_spot") {
    return `find_spot(${args.location}, ${result.category}) → ${result.count}곳`;
  }
  return name;
}

async function runAgent(messages, key) {
  const contents = messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.text }] }));
  const steps = [];
  const spots = [];
  let focus = null;
  let reply = "";

  for (let i = 0; i < MAX_STEPS; i++) {
    const data = await callGemini(contents, key);
    const cand = data.candidates?.[0];
    const parts = cand?.content?.parts ?? [];
    const calls = parts.filter((p) => p.functionCall);

    if (!calls.length) {
      reply = parts.map((p) => p.text || "").join("").trim();
      if (!reply) reply = data.promptFeedback?.blockReason ? "이 요청에는 답할 수 없어요." : "답변을 만들지 못했어요. 다시 질문해 주세요.";
      return { reply, steps, spots, focus };
    }

    contents.push({ role: "model", parts }); // 모델이 보낸 parts 를 그대로 되돌려 줘야 한다
    const responses = await Promise.all(
      calls.map(async ({ functionCall: fc }) => {
        let result;
        try {
          result = await runTool(fc.name, fc.args);
        } catch (e) {
          result = { error: e.message };
        }
        steps.push({ tool: fc.name, args: fc.args || {}, summary: describeStep(fc.name, fc.args || {}, result), ok: !result.error });
        if (fc.name === "get_weather" && !result.error) {
          focus = { name: result.location, lat: result.latitude, lon: result.longitude };
        }
        if (fc.name === "find_spot" && result.spots) spots.push(...result.spots);
        return { functionResponse: { name: fc.name, response: { result } } };
      })
    );
    contents.push({ role: "user", parts: responses });
  }

  return { reply: "요청이 복잡해서 끝까지 처리하지 못했어요. 지역이나 조건을 조금 더 구체적으로 알려 주세요.", steps, spots, focus };
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "POST 요청만 지원합니다." });

  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: "서버에 GEMINI_API_KEY 가 설정되지 않았습니다." });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  const messages = sanitizeMessages(body?.messages);
  if (!messages) return res.status(400).json({ error: "messages 형식이 올바르지 않습니다. (마지막 메시지는 user 여야 합니다)" });

  try {
    res.status(200).json(await runAgent(messages, key));
  } catch (e) {
    console.error("chat error:", e.message, e.detail || "");
    const quota = e.status === 429;
    res.status(502).json({ error: quota ? "AI 요청 한도를 초과했어요. 잠시 후 다시 시도해 주세요." : "AI 응답을 가져오지 못했어요. 잠시 후 다시 시도해 주세요." });
  }
};
