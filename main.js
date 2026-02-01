/*
  RugTown Live (정적 웹게임, GitHub Pages 배포용)
  - 텍스트 미션창 없음
  - 랜덤 사건 발생
  - 출동 건물(경찰서/소방서/병원)에서 사건 지점까지 도로를 손으로 드래그
  - iPhone/iPad 터치 최적화

  좌표계:
  - rug.png 원본은 900x900. 모든 월드 좌표는 0..900 기준.
*/

(() => {
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d', { alpha: false });

  const parentBtn = document.getElementById('parentBtn');
  const parentPanel = document.getElementById('parentPanel');
  const closeParent = document.getElementById('closeParent');
  const freqRange = document.getElementById('freq');
  const strictRange = document.getElementById('strict');
  const soundToggle = document.getElementById('sound');

  const RUG_SIZE = 900;

  // ====== 설정(보호자 패널) ======
  const settings = {
    // 사건 평균 간격(초). 실제는 약간 랜덤
    eventEverySec: parseInt(freqRange.value, 10),
    // 0..1. 높을수록 도로에서 벗어나면 더 엄격하게 무시
    strictness: parseFloat(strictRange.value),
    sound: soundToggle.checked
  };

  freqRange.addEventListener('input', () => {
    settings.eventEverySec = parseInt(freqRange.value, 10);
  });
  strictRange.addEventListener('input', () => {
    settings.strictness = parseFloat(strictRange.value);
  });
  soundToggle.addEventListener('change', () => {
    settings.sound = soundToggle.checked;
  });

  // 보호자 버튼: 길게 누르면 열리게(아이 실수 방지)
  let pressTimer = null;
  const OPEN_MS = 650;
  parentBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    pressTimer = setTimeout(() => {
      parentPanel.hidden = false;
    }, OPEN_MS);
  });
  const cancelPress = () => {
    if (pressTimer) clearTimeout(pressTimer);
    pressTimer = null;
  };
  parentBtn.addEventListener('pointerup', cancelPress);
  parentBtn.addEventListener('pointercancel', cancelPress);
  parentBtn.addEventListener('pointerleave', cancelPress);
  closeParent.addEventListener('click', () => (parentPanel.hidden = true));
  parentPanel.addEventListener('click', (e) => {
    if (e.target === parentPanel) parentPanel.hidden = true;
  });

  // ====== 오디오(파일 없이 간단 톤) ======
  let audioCtx = null;
  function beep(freq, dur = 0.08, type = 'sine', gain = 0.05) {
    if (!settings.sound) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = type;
      o.frequency.value = freq;
      g.gain.value = gain;
      o.connect(g);
      g.connect(audioCtx.destination);
      o.start();
      o.stop(audioCtx.currentTime + dur);
    } catch {
      // ignore
    }
  }

  // ====== 리사이즈 & 월드->스크린 변환 ======
  const view = {
    w: 1,
    h: 1,
    scale: 1,
    ox: 0,
    oy: 0
  };

  function resize() {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.floor(window.innerWidth * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';

    view.w = canvas.width;
    view.h = canvas.height;

    // 러그를 화면에 꽉 차게(레터박스)
    const s = Math.min(view.w, view.h) / RUG_SIZE;
    view.scale = s;
    view.ox = (view.w - RUG_SIZE * s) / 2;
    view.oy = (view.h - RUG_SIZE * s) / 2;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = true;
  }
  window.addEventListener('resize', resize);
  resize();

  function screenToWorld(px, py) {
    const x = (px - view.ox) / view.scale;
    const y = (py - view.oy) / view.scale;
    return { x, y };
  }
  function worldToScreen(x, y) {
    return {
      x: view.ox + x * view.scale,
      y: view.oy + y * view.scale
    };
  }

  // ====== 배경 이미지 로드 ======
  const rugImg = new Image();
  rugImg.src = 'assets/rug.png';

  // ====== 월드 오브젝트(건물/스팟) ======
  // (대략적인 위치) — 필요하면 숫자만 조정하면 됨.
  const POIS = {
    police: { id: 'police', x: 110, y: 700, r: 55, icon: '🚓' },      // 왼쪽 아래 파란 집
    fire:   { id: 'fire',   x: 445, y: 500, r: 65, icon: '🚒' },      // 가운데 빨간 헛간
    hospital:{id:'hospital',x: 705, y: 505, r: 70, icon: '🚑' },      // 오른쪽 큰 건물

    // 사건이 터질 수 있는 목표 건물들
    village: { id: 'village', x: 610, y: 265, r: 85 },               // 위쪽 마을
    castle:  { id: 'castle',  x: 215, y: 505, r: 85 },               // 왼쪽 성
    lighthouse:{id:'lighthouse', x: 85, y: 125, r: 70 },             // 등대
    shop:    { id: 'shop',    x: 835, y: 740, r: 70 },               // 오른쪽 아래 빌딩
    desert:  { id: 'desert',  x: 240, y: 820, r: 80 },               // 아래 캠프
  };

  const INCIDENT_TARGETS = [POIS.village, POIS.castle, POIS.shop, POIS.desert, POIS.lighthouse];

  // ====== 도로 그래프(간단 버전) ======
  // 러그 도로를 "대충" 따라가는 노드/엣지. (아이용이라 엄청 정밀할 필요 없음)
  // 좌표를 바꾸고 싶으면 여기 숫자만 조정하면 됨.
  const N = {
    A: {x: 110, y: 850},
    B: {x: 110, y: 700},
    C: {x: 110, y: 560},
    D: {x: 110, y: 410},
    E: {x: 110, y: 255},
    F: {x: 110, y: 110},

    G: {x: 285, y: 700},
    H: {x: 285, y: 520},
    I: {x: 285, y: 340},

    J: {x: 450, y: 700},
    K: {x: 450, y: 520},
    L: {x: 450, y: 340},
    M: {x: 450, y: 170},

    R: {x: 650, y: 700},
    S: {x: 650, y: 520},
    T: {x: 650, y: 340},
    U: {x: 650, y: 170},

    V: {x: 820, y: 700},
    W: {x: 820, y: 520},
    X: {x: 820, y: 340},
    Y: {x: 820, y: 170},

    Z: {x: 450, y: 820},
    Z2:{x: 650, y: 820}
  };

  // undirected edges
  const EDGES = [
    ['A','B'],['B','C'],['C','D'],['D','E'],['E','F'],
    ['B','G'],['G','J'],['J','R'],['R','V'],
    ['C','H'],['H','K'],['K','S'],['S','W'],
    ['D','I'],['I','L'],['L','T'],['T','X'],
    ['M','U'],['U','Y'],
    ['L','M'],['T','U'],
    ['J','K'],['K','L'],['S','T'],['T','R'],
    ['J','Z'],['Z','Z2'],['Z2','R'],
    ['V','W'],['W','X'],['X','Y'],
    ['M','F'],
    ['E','M'],
  ];

  const adjacency = new Map();
  function addAdj(a,b){
    if(!adjacency.has(a)) adjacency.set(a,[]);
    adjacency.get(a).push(b);
  }
  for(const [a,b] of EDGES){ addAdj(a,b); addAdj(b,a); }

  function dist2(ax,ay,bx,by){
    const dx=ax-bx, dy=ay-by;
    return dx*dx+dy*dy;
  }

  function nearestNode(x,y){
    let best=null, bestD=1e18;
    for(const [k,p] of Object.entries(N)){
      const d=dist2(x,y,p.x,p.y);
      if(d<bestD){bestD=d; best=k;}
    }
    return best;
  }

  function shortestPath(fromKey, toKey){
    if(fromKey===toKey) return [fromKey];
    const q=[fromKey];
    const prev=new Map();
    prev.set(fromKey, null);
    while(q.length){
      const cur=q.shift();
      for(const nb of (adjacency.get(cur)||[])){
        if(prev.has(nb)) continue;
        prev.set(nb, cur);
        if(nb===toKey){
          const path=[toKey];
          let t=toKey;
          while(prev.get(t)!==null){
            t=prev.get(t);
            path.push(t);
          }
          return path.reverse();
        }
        q.push(nb);
      }
    }
    return [fromKey];
  }

  // 도로 판정: 가장 가까운 엣지까지 거리
  function pointToSegmentDistance(x,y, ax,ay, bx,by){
    const vx = bx-ax, vy = by-ay;
    const wx = x-ax, wy = y-ay;
    const c1 = vx*wx + vy*wy;
    if(c1<=0) return Math.hypot(x-ax, y-ay);
    const c2 = vx*vx + vy*vy;
    if(c2<=c1) return Math.hypot(x-bx, y-by);
    const t = c1 / c2;
    const px = ax + t*vx;
    const py = ay + t*vy;
    return Math.hypot(x-px, y-py);
  }

  // 도로 네트워크와의 최소 거리(월드 단위)
  function distanceToRoad(x,y){
    let best=1e18;
    for(const [a,b] of EDGES){
      const A=N[a], B=N[b];
      const d=pointToSegmentDistance(x,y,A.x,A.y,B.x,B.y);
      if(d<best) best=d;
    }
    return best;
  }

  // ====== 사건(이벤트) ======
  const EventType = {
    THIEF: 'thief',
    FIRE: 'fire',
    MED: 'med'
  };

  function randInt(n){ return Math.floor(Math.random()*n); }
  function choice(arr){ return arr[randInt(arr.length)]; }

  let currentEvent = null;
  let nextEventAt = performance.now() + 1200;

  function scheduleNextEvent(now){
    const base = settings.eventEverySec * 1000;
    const jitter = (0.45 + Math.random()*0.9) * 1000; // 0.45~1.35s
    nextEventAt = now + base + jitter;
  }

  function startRandomEvent(){
    const type = choice([EventType.THIEF, EventType.FIRE, EventType.MED]);

    let station;
    let target;
    let emoji;
    let sfx;

    if(type===EventType.THIEF){
      station = POIS.police;
      target = choice(INCIDENT_TARGETS);
      emoji = '🦹';
      sfx = () => { beep(880,0.06,'square',0.03); beep(660,0.06,'square',0.03); };
    } else if(type===EventType.FIRE){
      station = POIS.fire;
      target = choice(INCIDENT_TARGETS);
      emoji = '🔥';
      sfx = () => { beep(520,0.08,'sawtooth',0.03); beep(430,0.08,'sawtooth',0.03); };
    } else {
      station = POIS.hospital;
      target = choice(INCIDENT_TARGETS);
      emoji = '💫';
      sfx = () => { beep(740,0.05,'triangle',0.03); beep(980,0.05,'triangle',0.03); };
    }

    // 동일 스팟 연속 방지
    if(currentEvent && currentEvent.target.id === target.id){
      target = choice(INCIDENT_TARGETS.filter(t => t.id !== currentEvent.target.id));
    }

    currentEvent = {
      type,
      station,
      target,
      emoji,
      startedAt: performance.now(),
      state: 'waiting', // waiting | dragging | resolving
      pulse: 0,
      hint: 1.0, // 힌트 강도(시간 지나면 감소)
      sfx
    };

    currentEvent.sfx?.();
  }

  // ====== 드래그 경로(아이 손가락) ======
  let dragging = false;
  let dragPath = []; // world points
  let dragValid = true;

  // 차량 애니메이션
  const vehicle = {
    active: false,
    emoji: '🚓',
    path: [],
    t: 0,
    speed: 260, // world units/sec
    x: 0,
    y: 0
  };

  function beginVehicle(station, ev){
    vehicle.active = true;
    vehicle.emoji = station.icon;
    vehicle.t = 0;
    vehicle.path = [];
    vehicle.x = station.x;
    vehicle.y = station.y;

    // 우선: 아이가 그린 길(유효하면)
    if(dragPath.length >= 2 && dragValid){
      vehicle.path = dragPath.slice();
    } else {
      // fallback: 최단 경로(노드 기반)
      const from = nearestNode(station.x, station.y);
      const to = nearestNode(ev.target.x, ev.target.y);
      const keys = shortestPath(from, to);
      vehicle.path = keys.map(k => ({x: N[k].x, y: N[k].y}));
      vehicle.path.push({x: ev.target.x, y: ev.target.y});
    }
  }

  function updateVehicle(dt){
    if(!vehicle.active || vehicle.path.length < 2) return;

    // segment-by-segment 이동
    let remaining = vehicle.speed * dt;
    while(remaining > 0 && vehicle.path.length >= 2){
      const a = {x: vehicle.x, y: vehicle.y};
      const b = vehicle.path[1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.hypot(dx, dy);
      if(d < 1e-3){
        vehicle.x = b.x;
        vehicle.y = b.y;
        vehicle.path.shift();
        continue;
      }
      if(d <= remaining){
        vehicle.x = b.x;
        vehicle.y = b.y;
        vehicle.path.shift();
        remaining -= d;
      } else {
        const t = remaining / d;
        vehicle.x += dx * t;
        vehicle.y += dy * t;
        remaining = 0;
      }
    }

    if(vehicle.path.length < 2){
      vehicle.active = false;
    }
  }

  // ====== 입력 처리 ======
  function withinPoi(poi, x,y){
    return Math.hypot(x-poi.x, y-poi.y) <= poi.r;
  }

  function onPointerDown(e){
    if(parentPanel.hidden === false) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const px = (e.clientX - rect.left) * dpr;
    const py = (e.clientY - rect.top) * dpr;
    const w = screenToWorld(px, py);

    // 이벤트 없으면 무시
    if(!currentEvent || currentEvent.state !== 'waiting') return;

    // 출동 건물에서 시작해야 함
    if(withinPoi(currentEvent.station, w.x, w.y)){
      dragging = true;
      dragPath = [{x: currentEvent.station.x, y: currentEvent.station.y}];
      dragValid = true;
      currentEvent.state = 'dragging';
      currentEvent.hint = 0.0;
      beep(1040, 0.05, 'triangle', 0.03);
    }
  }

  function onPointerMove(e){
    if(!dragging) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const px = (e.clientX - rect.left) * dpr;
    const py = (e.clientY - rect.top) * dpr;
    const w = screenToWorld(px, py);

    // 도로에서 너무 벗어나면(엄격도에 따라) 포인트를 덜 받음
    const d = distanceToRoad(w.x, w.y);
    const tol = 34 + (1 - settings.strictness) * 26; // 34~60

    if(d <= tol){
      const last = dragPath[dragPath.length - 1];
      const step = 10; // 너무 촘촘하지 않게
      if(Math.hypot(w.x - last.x, w.y - last.y) >= step){
        dragPath.push({x: w.x, y: w.y});
      }
    } else {
      // 벗어나면 유효성만 살짝 깎기
      dragValid = false;
    }
  }

  function onPointerUp(e){
    if(!dragging) return;
    dragging = false;

    const rect = canvas.getBoundingClientRect();
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const px = (e.clientX - rect.left) * dpr;
    const py = (e.clientY - rect.top) * dpr;
    const w = screenToWorld(px, py);

    // 목표 근처에서 끝났는지 확인
    if(currentEvent && currentEvent.state === 'dragging'){
      const ok = withinPoi(currentEvent.target, w.x, w.y);
      if(ok){
        currentEvent.state = 'resolving';
        beginVehicle(currentEvent.station, currentEvent);
        beep(1320, 0.07, 'sine', 0.05);
      } else {
        // 실패 패널티 없음: 다시 대기 상태로
        currentEvent.state = 'waiting';
        dragPath = [];
        beep(240, 0.07, 'sine', 0.03);
      }
    }
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove, { passive: false });
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);

  // iOS: 더블탭 확대 방지
  document.addEventListener('gesturestart', (e) => e.preventDefault());

  // ====== 파티클/이펙트 ======
  const pops = [];
  function spawnPop(x,y, kind='spark'){
    for(let i=0;i<18;i++){
      pops.push({
        x, y,
        vx: (Math.random()*2-1) * (60 + Math.random()*120),
        vy: (Math.random()*2-1) * (60 + Math.random()*120),
        life: 0.55 + Math.random()*0.25,
        t: 0,
        kind
      });
    }
  }

  function updatePops(dt){
    for(const p of pops){
      p.t += dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 260 * dt; // gravity
    }
    for(let i=pops.length-1;i>=0;i--){
      if(pops[i].t >= pops[i].life) pops.splice(i,1);
    }
  }

  // ====== 렌더 헬퍼 ======
  function drawRug(){
    ctx.fillStyle = '#0b0f12';
    ctx.fillRect(0,0,view.w,view.h);
    if(!rugImg.complete) return;

    ctx.save();
    ctx.translate(view.ox, view.oy);
    ctx.scale(view.scale, view.scale);
    ctx.drawImage(rugImg, 0,0, RUG_SIZE, RUG_SIZE);
    ctx.restore();
  }

  function ring(x,y, radius, t, color='rgba(255,255,255,0.9)'){
    const s = worldToScreen(x,y);
    const r = radius * view.scale;
    ctx.save();
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(2, 6 * view.scale);
    ctx.globalAlpha = 0.35 + 0.35 * Math.sin(t);
    ctx.arc(s.x, s.y, r + (6*view.scale)*Math.sin(t*1.2), 0, Math.PI*2);
    ctx.stroke();
    ctx.restore();
  }

  function drawEmoji(x,y, emoji, size=40){
    const s = worldToScreen(x,y);
    ctx.save();
    ctx.font = `${Math.floor(size*view.scale)}px system-ui, Apple Color Emoji, Segoe UI Emoji`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(emoji, s.x, s.y);
    ctx.restore();
  }

  function drawDragPath(){
    if(!dragging || dragPath.length < 2) return;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    const p0 = worldToScreen(dragPath[0].x, dragPath[0].y);
    ctx.moveTo(p0.x, p0.y);
    for(let i=1;i<dragPath.length;i++){
      const p = worldToScreen(dragPath[i].x, dragPath[i].y);
      ctx.lineTo(p.x, p.y);
    }
    ctx.strokeStyle = dragValid ? 'rgba(255,255,255,0.85)' : 'rgba(255,120,120,0.85)';
    ctx.lineWidth = Math.max(6, 14 * view.scale);
    ctx.stroke();
    ctx.restore();
  }

  function drawVehicle(){
    if(!vehicle.active) return;
    // 차량 아이콘
    drawEmoji(vehicle.x, vehicle.y, vehicle.emoji, 44);

    // 차량 앞에 작은 반짝
    ring(vehicle.x, vehicle.y, 16, performance.now()/180, 'rgba(255,255,255,0.65)');
  }

  function drawPops(){
    ctx.save();
    for(const p of pops){
      const a = 1 - (p.t / p.life);
      const s = worldToScreen(p.x, p.y);
      ctx.globalAlpha = a;
      ctx.beginPath();
      ctx.arc(s.x, s.y, Math.max(1, 4*view.scale), 0, Math.PI*2);
      ctx.fillStyle = 'white';
      ctx.fill();
    }
    ctx.restore();
  }

  function drawHint(ev, now){
    if(!ev) return;
    if(ev.hint <= 0) return;

    // 출동 건물 -> 목표까지 최단 경로를 점선으로 아주 옅게
    const from = nearestNode(ev.station.x, ev.station.y);
    const to = nearestNode(ev.target.x, ev.target.y);
    const keys = shortestPath(from, to);
    const pts = keys.map(k => N[k]);
    pts.push({x: ev.target.x, y: ev.target.y});

    ctx.save();
    ctx.setLineDash([10*view.scale, 10*view.scale]);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalAlpha = 0.20 * ev.hint;
    ctx.strokeStyle = 'white';
    ctx.lineWidth = Math.max(2, 10*view.scale);

    ctx.beginPath();
    const p0 = worldToScreen(pts[0].x, pts[0].y);
    ctx.moveTo(p0.x, p0.y);
    for(let i=1;i<pts.length;i++){
      const p = worldToScreen(pts[i].x, pts[i].y);
      ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
    ctx.restore();
  }

  // ====== 게임 루프 ======
  let last = performance.now();

  function tick(now){
    const dt = Math.min(0.033, (now - last) / 1000);
    last = now;

    // 사건 생성
    if(!currentEvent && now >= nextEventAt){
      startRandomEvent();
      scheduleNextEvent(now);
    }

    // 사건 진행
    if(currentEvent){
      currentEvent.pulse += dt;
      // 힌트는 시작 후 3~4초에 걸쳐 천천히 줄임
      currentEvent.hint = Math.max(0, currentEvent.hint - dt * 0.25);

      // 해결 중이면 차량 업데이트
      if(currentEvent.state === 'resolving'){
        updateVehicle(dt);

        // 차량이 도착하면 해결
        if(!vehicle.active){
          // 해결 이펙트
          spawnPop(currentEvent.target.x, currentEvent.target.y);
          beep(1560, 0.08, 'triangle', 0.05);
          beep(1960, 0.06, 'triangle', 0.04);
          currentEvent = null;
          dragPath = [];
        }
      }
    }

    updatePops(dt);

    // ====== 렌더 ======
    drawRug();

    // 사건 표시(깜빡/링/이모지)
    if(currentEvent){
      const t = now / 240;
      ring(currentEvent.station.x, currentEvent.station.y, currentEvent.station.r*0.68, t);
      ring(currentEvent.target.x, currentEvent.target.y, currentEvent.target.r*0.72, t*1.1, 'rgba(255,220,120,0.95)');

      // 사건 아이콘(불/도둑/어지럼)
      drawEmoji(currentEvent.target.x, currentEvent.target.y - 22, currentEvent.emoji, 46);

      // 출동 건물 아이콘 강조
      drawEmoji(currentEvent.station.x, currentEvent.station.y - 20, currentEvent.station.icon, 40);

      // 힌트 점선
      drawHint(currentEvent, now);
    }

    drawDragPath();
    drawVehicle();
    drawPops();

    requestAnimationFrame(tick);
  }

  // 시작: 이미지 로드 후 루프
  rugImg.onload = () => {
    scheduleNextEvent(performance.now());
    requestAnimationFrame(tick);
  };
  rugImg.onerror = () => {
    // 이미지 실패 시에도 실행(검은 화면)
    scheduleNextEvent(performance.now());
    requestAnimationFrame(tick);
  };
})();
