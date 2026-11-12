// three.js 3D 지형 지도: 고도 타일(Terrarium)로 지형을 만들고 OSM 지도를 텍스처로 입힘
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const Z = 8;                 // 타일 줌 레벨
const TILE = 256;
const UNIT = 100;            // 월드 1 단위 = 줌8 기준 100px
const MPP = 495;             // 줌8, 위도 36° 에서 1px ≈ 495m
const EXAG = 6;              // 고도 과장 배율
const STEP = 4;              // 지형 샘플 간격(px)
const BBOX = { west: 124.3, east: 132.2, south: 32.9, north: 38.9 }; // 제주·울릉·독도 포함

const OSM = (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
const DEM = (z, x, y) => `https://elevation-tiles-prod.s3.amazonaws.com/terrarium/${z}/${x}/${y}.png`;

const N = TILE * 2 ** Z;
function mercPx(lat, lon) {
  const s = Math.sin((lat * Math.PI) / 180);
  return { x: ((lon + 180) / 360) * N, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * N };
}
function pxToLatLon(px, py) {
  return {
    lon: (px / N) * 360 - 180,
    lat: (Math.atan(Math.sinh(Math.PI * (1 - (2 * py) / N))) * 180) / Math.PI,
  };
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(url));
    img.src = url;
  });
}

function makeLabel(text, color) {
  const c = document.createElement("canvas");
  c.width = 320; c.height = 80;
  const g = c.getContext("2d");
  g.font = "bold 34px system-ui, 'Malgun Gothic', sans-serif";
  const w = Math.min(310, g.measureText(text).width + 36);
  const x = (c.width - w) / 2;
  g.fillStyle = color;
  g.strokeStyle = "#fff";
  g.lineWidth = 5;
  g.beginPath();
  g.roundRect(x, 10, w, 60, 30);
  g.fill();
  g.stroke();
  g.fillStyle = "#fff";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, c.width / 2, 41, 290);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
  sprite.scale.set(1.5, 0.375, 1);
  return sprite;
}

export function createScene({ container, onPinClick, onGroundClick }) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0xbfd9ee);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);
  camera.position.set(0, 17, 15);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.47;
  controls.minDistance = 1.5;
  controls.maxDistance = 40;
  controls.target.set(0, 0, 0);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.5));
  const sun = new THREE.DirectionalLight(0xffffff, 1.8);
  sun.position.set(-8, 10, -6);
  scene.add(sun);

  // ---- 타일 범위 (월드 좌표 계산 기준) ----
  const tl = mercPx(BBOX.north, BBOX.west);
  const br = mercPx(BBOX.south, BBOX.east);
  const tx0 = Math.floor(tl.x / TILE), ty0 = Math.floor(tl.y / TILE);
  const tx1 = Math.floor(br.x / TILE), ty1 = Math.floor(br.y / TILE);
  const W = (tx1 - tx0 + 1) * TILE, H = (ty1 - ty0 + 1) * TILE;
  const originX = tx0 * TILE, originY = ty0 * TILE;

  const toWorld = (lat, lon) => {
    const p = mercPx(lat, lon);
    return { x: (p.x - originX - W / 2) / UNIT, z: (p.y - originY - H / 2) / UNIT };
  };
  const worldToLatLon = (x, z) => pxToLatLon(x * UNIT + W / 2 + originX, z * UNIT + H / 2 + originY);

  // ---- 지형 ----
  let elev = null; // ImageData (고도 타일을 이어붙인 것)
  const elevM = (px, py) => {
    if (!elev) return 0;
    const x = Math.max(0, Math.min(W - 1, Math.round(px)));
    const y = Math.max(0, Math.min(H - 1, Math.round(py)));
    const i = (y * W + x) * 4;
    const m = elev.data[i] * 256 + elev.data[i + 1] + elev.data[i + 2] / 256 - 32768;
    return Math.max(0, m); // 바다(수심)는 0
  };
  const groundY = (lat, lon) => {
    const p = mercPx(lat, lon);
    return (elevM(p.x - originX, p.y - originY) / MPP) * EXAG / UNIT;
  };

  let terrain = null;
  function buildTerrain(texCanvas) {
    const segW = Math.floor(W / STEP), segH = Math.floor(H / STEP);
    const pos = new Float32Array((segW + 1) * (segH + 1) * 3);
    const uv = new Float32Array((segW + 1) * (segH + 1) * 2);
    let k = 0, u = 0;
    for (let j = 0; j <= segH; j++) {
      for (let i = 0; i <= segW; i++) {
        const px = (i / segW) * W, py = (j / segH) * H;
        pos[k++] = (px - W / 2) / UNIT;
        pos[k++] = (elevM(px, py) / MPP) * EXAG / UNIT;
        pos[k++] = (py - H / 2) / UNIT;
        uv[u++] = i / segW;
        uv[u++] = 1 - j / segH;
      }
    }
    const idx = [];
    for (let j = 0; j < segH; j++) {
      for (let i = 0; i < segW; i++) {
        const a = j * (segW + 1) + i, b = a + 1, c = a + segW + 1, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const tex = new THREE.CanvasTexture(texCanvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    terrain = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: tex }));
    scene.add(terrain);
  }

  async function loadTerrain() {
    const texCanvas = document.createElement("canvas");
    texCanvas.width = W; texCanvas.height = H;
    const demCanvas = document.createElement("canvas");
    demCanvas.width = W; demCanvas.height = H;
    const tctx = texCanvas.getContext("2d");
    const dctx = demCanvas.getContext("2d", { willReadFrequently: true });
    tctx.fillStyle = "#aad3df"; tctx.fillRect(0, 0, W, H);

    const jobs = [];
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const dx = (tx - tx0) * TILE, dy = (ty - ty0) * TILE;
        jobs.push(loadImage(OSM(Z, tx, ty)).then((im) => tctx.drawImage(im, dx, dy)).catch(() => {}));
        jobs.push(loadImage(DEM(Z, tx, ty)).then((im) => dctx.drawImage(im, dx, dy)).catch(() => {}));
      }
    }
    await Promise.all(jobs);
    try { elev = dctx.getImageData(0, 0, W, H); } catch { elev = null; } // CORS 문제 시 평평한 지도
    buildTerrain(texCanvas);
  }

  // ---- 핀(막대) ----
  const pinGroup = new THREE.Group();
  scene.add(pinGroup);
  const barGeo = new THREE.CylinderGeometry(0.09, 0.11, 1, 20).translate(0, 0.5, 0);
  let lastPins = [];

  function disposeGroup(g) {
    for (const o of [...g.children]) {
      g.remove(o);
      o.material?.map?.dispose();
      o.material?.dispose();
    }
  }

  /** items: [{ place, color, label, height }] */
  function setPins(items) {
    lastPins = items;
    disposeGroup(pinGroup);
    for (const it of items) {
      const { x, z } = toWorld(it.place.lat, it.place.lon);
      const gy = groundY(it.place.lat, it.place.lon);
      const bar = new THREE.Mesh(barGeo, new THREE.MeshLambertMaterial({ color: it.color }));
      bar.position.set(x, gy, z);
      bar.scale.y = Math.max(0.05, it.height);
      bar.userData.place = it.place;
      const label = makeLabel(it.label, it.color);
      label.position.set(x, gy + Math.max(0.05, it.height) + 0.25, z);
      label.userData.place = it.place;
      pinGroup.add(bar, label);
    }
  }

  // ---- 선택 표시 + 카메라 이동 ----
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.3, 0.035, 10, 40).rotateX(Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x1b2a3a })
  );
  ring.visible = false;
  scene.add(ring);
  let selected = null;

  function placeRing() {
    if (!selected) return;
    const { x, z } = toWorld(selected.lat, selected.lon);
    ring.position.set(x, groundY(selected.lat, selected.lon) + 0.03, z);
    ring.visible = true;
  }

  let tween = null;
  function flyTo(lat, lon) {
    const { x, z } = toWorld(lat, lon);
    const to = new THREE.Vector3(x, groundY(lat, lon), z);
    const off = camera.position.clone().sub(controls.target);
    off.setLength(Math.min(off.length(), 8));
    tween = {
      t0: performance.now(), dur: 900,
      fromT: controls.target.clone(), toT: to,
      fromP: camera.position.clone(), toP: to.clone().add(off),
    };
  }

  function select(place, { fly = true } = {}) {
    selected = place;
    placeRing();
    if (fly) flyTo(place.lat, place.lon);
  }

  // ---- 클릭 선택 ----
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let down = null;
  const el = renderer.domElement;
  el.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY }; });
  el.addEventListener("pointerup", (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
    const r = el.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hitPin = ray.intersectObjects(pinGroup.children, false)[0];
    if (hitPin) return onPinClick?.(hitPin.object.userData.place);
    if (!terrain) return;
    const hit = ray.intersectObject(terrain, false)[0];
    if (hit) onGroundClick?.(worldToLatLon(hit.point.x, hit.point.z));
  });

  // ---- 루프 / 리사이즈 ----
  // 처음 한 번: 화면 비율에 맞춰 한반도 전체가 보이도록 카메라 거리 계산
  function fitCamera() {
    const halfW = ((br.x - tl.x) / UNIT) / 2, halfH = ((br.y - tl.y) / UNIT) / 2;
    const t = Math.tan((camera.fov * Math.PI) / 360);
    const dist = Math.max(halfW / (t * camera.aspect), (halfH / t) * 0.85) * 1.05;
    const tilt = (50 * Math.PI) / 180;
    controls.target.set(0, 0, 0);
    camera.position.set(0, Math.cos(tilt) * dist, Math.sin(tilt) * dist);
  }

  function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener("resize", resize);
  resize();
  fitCamera();

  renderer.setAnimationLoop((now) => {
    if (tween) {
      const k = Math.min(1, (now - tween.t0) / tween.dur);
      const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2; // easeInOut
      controls.target.lerpVectors(tween.fromT, tween.toT, e);
      camera.position.lerpVectors(tween.fromP, tween.toP, e);
      if (k >= 1) tween = null;
    }
    ring.scale.setScalar(1 + 0.12 * Math.sin(now / 250));
    controls.update();
    renderer.render(scene, camera);
  });

  // 지형이 준비되면 핀/선택 링 높이를 지형에 맞춰 다시 배치
  const ready = loadTerrain().then(() => { setPins(lastPins); placeRing(); });

  return { ready, setPins, select, toWorld };
}
