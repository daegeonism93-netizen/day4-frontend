// AI 여행 추천 채팅: /api/chat (Vercel 함수) 호출, 결과 장소를 지도에 표시
// app.js 의 전역(map, selectPlace)을 사용하므로 app.js 다음에 로드한다.
(function () {
  const $ = (id) => document.getElementById(id);
  const log = $("chatLog");
  const form = $("chatForm");
  const input = $("chatInput");
  const sendBtn = $("chatSend");
  const history = []; // { role: "user" | "assistant", text }
  const spotLayer = L.layerGroup().addTo(map);
  let busy = false;

  const HINTS = [
    "이번 주말 강릉 가려는데 뭐 하면 좋을까?",
    "비 오는 날 서울에서 갈 만한 곳",
    "미세먼지 심한 날 부산 실내 데이트",
    "제주 지금 날씨 어때?",
  ];

  // **굵게** 만 지원하는 안전한 렌더링 (innerHTML 사용 안 함)
  function renderText(el, text) {
    el.replaceChildren();
    text.split("\n").forEach((line, i, arr) => {
      const clean = line.replace(/^\s*[*-]\s+/, "• ");
      clean.split(/(\*\*[^*]+\*\*)/g).forEach((chunk) => {
        if (/^\*\*[^*]+\*\*$/.test(chunk)) {
          const b = document.createElement("strong");
          b.textContent = chunk.slice(2, -2);
          el.append(b);
        } else if (chunk) {
          el.append(chunk);
        }
      });
      if (i < arr.length - 1) el.append("\n");
    });
  }

  function addMsg(kind, text) {
    const el = document.createElement("div");
    el.className = `msg ${kind}`;
    if (kind === "bot") renderText(el, text); else el.textContent = text;
    log.append(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  function addSteps(steps) {
    if (!steps.length) return;
    const box = document.createElement("div");
    box.className = "steps";
    for (const s of steps) {
      const d = document.createElement("div");
      d.className = `step${s.ok ? "" : " fail"}`;
      d.textContent = `🔧 ${s.summary}`;
      box.append(d);
    }
    log.append(box);
  }

  function showSpots(spots) {
    spotLayer.clearLayers();
    if (!spots.length) return;
    const pts = [];
    spots.forEach((s, i) => {
      const el = document.createElement("div");
      el.className = "spot";
      const n = document.createElement("b");
      n.textContent = String(i + 1);
      el.append(n);
      const pop = document.createElement("div");
      pop.className = "spot-pop";
      const name = document.createElement("strong");
      name.textContent = `${i + 1}. ${s.name}`;
      const meta = document.createElement("span");
      meta.textContent = [s.category, `${s.distance_km}km`].join(" · ");
      pop.append(name, meta);
      if (s.address) { const a = document.createElement("span"); a.textContent = s.address; pop.append(a); }
      L.marker([s.lat, s.lon], { icon: L.divIcon({ html: el, className: "spot-wrap", iconSize: [0, 0] }) })
        .bindPopup(pop)
        .addTo(spotLayer);
      pts.push([s.lat, s.lon]);
    });
    map.flyToBounds(L.latLngBounds(pts), { maxZoom: 13, padding: [60, 60], duration: 0.8 });
  }

  async function send(text) {
    if (busy || !text.trim()) return;
    busy = true;
    sendBtn.disabled = true;
    $("chatHints").hidden = true;
    addMsg("user", text);
    history.push({ role: "user", text });
    const typing = addMsg("bot typing", "생각하는 중… (날씨·장소를 조회하고 있어요)");

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history }),
      });
      const data = await res.json().catch(() => ({}));
      typing.remove();
      if (!res.ok) throw new Error((data.error || `서버 오류 (${res.status})`) + (data.detail ? ` [${data.detail}]` : ""));

      addSteps(data.steps || []);
      addMsg("bot", data.reply);
      history.push({ role: "assistant", text: data.reply });
      showSpots(data.spots || []);
      // 날씨를 조회한 지역을 왼쪽 패널에도 표시
      if (data.focus && typeof selectPlace === "function") {
        selectPlace({ name: data.focus.name, region: "AI가 조회한 지역", en: "", lat: data.focus.lat, lon: data.focus.lon }, { fly: !(data.spots || []).length });
      }
    } catch (e) {
      typing.remove();
      history.pop(); // 실패한 질문은 기록에서 제거해 재시도 가능하게
      addMsg("error", `⚠️ ${e instanceof TypeError ? "서버에 연결할 수 없어요." : e.message}`);
    } finally {
      busy = false;
      sendBtn.disabled = false;
      input.focus();
    }
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim().slice(0, 500);
    input.value = "";
    send(text);
  });

  const hints = $("chatHints");
  HINTS.forEach((h) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = h;
    b.addEventListener("click", () => send(h));
    hints.append(b);
  });

  const panel = $("chat");
  const fab = $("chatFab");
  fab.addEventListener("click", () => {
    const open = panel.classList.toggle("open");
    fab.textContent = open ? "✕ 닫기" : "💬 AI 추천";
    if (open) input.focus();
  });
  addMsg("bot", "안녕하세요! 가고 싶은 지역이나 하고 싶은 것을 말해 주세요.\n실시간 날씨와 미세먼지를 확인하고, 지금 가기 좋은 장소를 추천해 드려요.");
  if (window.matchMedia("(min-width: 900px)").matches) fab.click();
})();
