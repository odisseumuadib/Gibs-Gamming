(() => {
  // ====== CONFIG ======
  const CONFIG = {
    itemSelector: '.artifact',
    // Se o site tiver um atributo de id real, declare aqui:
    idAttrCandidates: ['data-id', 'data-item-id', 'data-artifact-id'],
    levelSel: '.artifact_level',
    starsSel: '.artifact_stars .artifact_stars_normal',
    imgSel: 'img.artifact_image',
    mainBlockSel: '.artifact_primary',
    subBlockSel: '.artifact_substat_container .artifact_substat',
    ratingNowSel: '.artifact_rating > :first-child',
    ratingMaxSel: '.artifact_rating .artifact_rating_maximum',
    scrollStep: 800,         // px por tick
    tickMs: 180,             // intervalo entre rolagens
    idleCyclesToStop: 10,    // para automaticamente se não aparecerem itens novos
    debug: false
  };

  // ====== STATE ======
  const S = (window._raidExtract = window._raidExtract || {
    running: false,
    paused: false,
    timer: null,
    data: new Map(), // id -> item
    seen: new Set(),
    idleCycles: 0,
    hud: null
  });

  // ====== HELPERS ======
  const q = (sel, el=document) => el.querySelector(sel);
  const qa = (sel, el=document) => Array.from(el.querySelectorAll(sel));
  const text = el => (el ? el.textContent.trim() : '');

  // --- viewport detection (prioriza Angular CDK) ---
  function getViewport() {
    // 1) Angular CDK
    const vps = Array.from(document.querySelectorAll('.cdk-virtual-scroll-viewport'))
      .filter(el => el.offsetParent !== null);
    if (vps.length) {
      // maior visível
      return vps.sort((a,b)=>b.clientHeight - a.clientHeight)[0];
    }
    // 2) Maior container rolável visível
    const candidates = qa('*').filter(el => {
      const s = getComputedStyle(el);
      return (s.overflowY === 'auto' || s.overflowY === 'scroll') &&
             el.scrollHeight > el.clientHeight && el.clientHeight > 300 &&
             el.offsetParent !== null;
    }).sort((a,b)=>b.clientHeight - a.clientHeight);
    return candidates[0] || document.scrollingElement || document.body;
  }

  // --- rolagem robusta para CDK ---
  function doScroll(vp, step) {
    const before = vp.scrollTop;
    // tentativa 1: scrollTop direto
    vp.scrollTop = before + step;

    // tentativa 2: wheel (CDK costuma escutar wheel)
    setTimeout(() => {
      if (vp.scrollTop === before) {
        vp.dispatchEvent(new WheelEvent('wheel', {deltaY: step, bubbles: true, cancelable: true}));
      }
    }, 20);

    // tentativa 3: PageDown com foco
    setTimeout(() => {
      if (vp.scrollTop === before) {
        vp.focus?.();
        vp.dispatchEvent(new KeyboardEvent('keydown', {key: 'PageDown', code: 'PageDown', bubbles: true}));
      }
    }, 40);
  }

  function getIdFrom(el) {
    for (const att of CONFIG.idAttrCandidates) {
      const v = el.getAttribute(att);
      if (v) return String(v);
    }
    // fallback: pseudo id estável
    const img = q(CONFIG.imgSel, el)?.getAttribute('src') || '';
    const level = text(q(CONFIG.levelSel, el)).replace(/\D+/g,'');
    const rarityClass = (el.className.match(/artifact_(\w+)/)||[])[1] || '';
    const stars = qa(CONFIG.starsSel, el).length;
    const key = [img, level, rarityClass, stars, el.innerText.slice(0,200)].join('|');
    let h = 0; for (let i=0;i<key.length;i++) { h = (h*31 + key.charCodeAt(i))|0; }
    return `pseudo_${Math.abs(h)}`;
  }

  function parseStatBlock(el) {
    if (!el) return null;
    const titleEl = el.querySelector('.artifact_stat_title');
    const valEl = el.querySelector('.artifact_stat_value');
    const rollsEl = el.querySelector('.artifact_roll_count');
    const name = titleEl ? titleEl.childNodes[0].textContent.trim() : '';
    const valRaw = text(valEl);
    const isPct = /%/.test(valRaw);
    const value = parseFloat(valRaw.replace(/[^\d.]/g,''));
    const rolls = rollsEl ? +rollsEl.textContent.replace(/[()]/g,'') : 0;
    return { stat: name, value, isPct, isFlat: !isPct, rolls };
  }

  function extractOne(card) {
    const id = getIdFrom(card);
    const img = q(CONFIG.imgSel, card)?.getAttribute('src') || '';
    const m = img.match(/ArtifactsIcons\/([^_]+)_([^./]+)\.jpg/i);
    const set = m ? m[1] : '';
    const slot = m ? m[2] : '';
    const rarity = (card.className.match(/artifact_(\w+)/)||[])[1] || '';
    const stars = qa(CONFIG.starsSel, card).length;
    const level = +(text(q(CONFIG.levelSel, card)).replace(/\D+/g,'') || 0);
    const main = parseStatBlock(q(CONFIG.mainBlockSel, card));
    const subs = qa(CONFIG.subBlockSel, card).map(parseStatBlock).filter(Boolean);
    const rating_now = text(q(CONFIG.ratingNowSel, card));
    const rating_max = text(q(CONFIG.ratingMaxSel, card));
    return {
      id, set, slot, rarity, stars, level,
      main_stat: main, substats: subs,
      rating_now, rating_max, imgSrc: img
    };
  }

  function sampleOnce() {
    const cards = qa(CONFIG.itemSelector);
    let added = 0;
    for (const c of cards) {
      const id = getIdFrom(c);
      if (S.seen.has(id)) continue;
      const item = extractOne(c);
      S.seen.add(id);
      S.data.set(id, item);
      added++;
    }
    return added;
  }

  function updateHUD(vp) {
    if (!S.hud) {
      const d = document.createElement('div');
      d.style.cssText = `
        position:fixed; right:12px; bottom:12px; z-index:999999;
        background:rgba(20,20,30,.92); color:#fff; padding:10px 12px;
        font:12px/1.2 system-ui,Segoe UI,Roboto; border-radius:8px; box-shadow:0 2px 8px rgba(0,0,0,.35);
      `;
      document.body.appendChild(d);
      S.hud = d;
    }
    S.hud.innerHTML = `
      <div><b>RAID Extractor</b> ${S.running ? (S.paused? '⏸️' : '▶️') : '⏹️'}</div>
      <div>Itens coletados: <b>${S.data.size}</b></div>
      <div>Idle cycles: ${S.idleCycles}/${CONFIG.idleCyclesToStop}</div>
      <div>ScrollTop: ${Math.round(vp.scrollTop)} / ${Math.max(0, vp.scrollHeight - vp.clientHeight)}</div>
      <div style="margin-top:6px;">
        <button id="_rx_pause">Pausar</button>
        <button id="_rx_resume">Retomar</button>
        <button id="_rx_stop">Parar+Exportar</button>
      </div>
    `;
    q('#_rx_pause')?.addEventListener('click', pause, {once:true});
    q('#_rx_resume')?.addEventListener('click', resume, {once:true});
    q('#_rx_stop')?.addEventListener('click', stopAndExport, {once:true});
  }

  function tick(vp) {
    if (!S.running || S.paused) return;

    const added = sampleOnce();
    if (CONFIG.debug && added) console.log('[extract] +', added, 'total', S.data.size);
    S.idleCycles = added ? 0 : (S.idleCycles + 1);

    // Auto-stop se não aparecer item novo por X ciclos
    if (S.idleCycles >= CONFIG.idleCyclesToStop) {
      stopAndExport();
      return;
    }

    // rola usando estratégia robusta
    doScroll(vp, CONFIG.scrollStep);
    updateHUD(vp);
  }

  function exportJSON() {
    const arr = Array.from(S.data.values());
    const blob = new Blob([JSON.stringify(arr, null, 2)], {type:'application/json'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `inventory_${arr.length}.json`;
    document.body.appendChild(a); a.click(); a.remove();
  }

  function exportCSV() {
    const rows = [
      ['id','set','slot','rarity','stars','level','main_stat','main_val','main_isPct','sub1','sub1_val','sub1_isPct','sub1_rolls','sub2','sub2_val','sub2_isPct','sub2_rolls','sub3','sub3_val','sub3_isPct','sub3_rolls','sub4','sub4_val','sub4_isPct','sub4_rolls','rating_now','rating_max','imgSrc']
    ];
    for (const it of S.data.values()) {
      const s = it.substats || [];
      rows.push([
        it.id, it.set, it.slot, it.rarity, it.stars, it.level,
        it.main_stat?.stat || '', it.main_stat?.value ?? '', it.main_stat?.isPct ?? '',
        s[0]?.stat||'', s[0]?.value??'', s[0]?.isPct??'', s[0]?.rolls??'',
        s[1]?.stat||'', s[1]?.value??'', s[1]?.isPct??'', s[1]?.rolls??'',
        s[2]?.stat||'', s[2]?.value??'', s[2]?.isPct??'', s[2]?.rolls??'',
        s[3]?.stat||'', s[3]?.value??'', s[3]?.isPct??'', s[3]?.rolls??'',
        it.rating_now||'', it.rating_max||'', it.imgSrc||''
      ]);
    }
    const csv = rows.map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], {type:'text/csv'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `inventory_${S.data.size}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
  }

  function pause() { S.paused = true; }
  function resume() { 
    if (!S.running) return;
    S.paused = false; S.idleCycles = 0;
    loop();
  }
  function stopAndExport() {
    S.running = false;
    clearInterval(S.timer); S.timer = null;
    try { exportJSON(); exportCSV(); } catch(e) { console.error(e); }
    if (S.hud) S.hud.remove(), S.hud = null;
    console.log('[extract] done', S.data.size);
  }

  function loop() {
    if (S.timer) clearInterval(S.timer);
    const vp = getViewport();
    updateHUD(vp);
    S.timer = setInterval(()=>tick(vp), CONFIG.tickMs);
  }

  // ====== PUBLIC API ======
  window.RaidOptimizerExtractor = {
    start(){
      if (S.running) return console.warn('Extractor já está rodando.');
      S.running = true; S.paused = false; S.idleCycles = 0;
      loop();
      console.log('▶️ Extractor iniciado. Use RaidOptimizerExtractor.pause(), .resume(), .stop()');
    },
    pause, resume,
    stop: stopAndExport,
    data: () => Array.from(S.data.values()),
    clear(){
      S.running=false; clearInterval(S.timer); S.timer=null;
      S.data.clear(); S.seen.clear(); if (S.hud) S.hud.remove(), S.hud=null;
      console.log('limpo.');
    }
  };

  // auto-start na primeira execução
  if (!S.running) window.RaidOptimizerExtractor.start();
})();
