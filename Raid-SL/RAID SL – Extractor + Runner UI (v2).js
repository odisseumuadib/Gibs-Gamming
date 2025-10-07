(() => {
  /*********************************************************************
   * RAID SL – Extractor + Runner UI (v2)
   * - Extração (Angular CDK virtual scroll)
   * - Parser set/slot robusto (decodeURI + espaço/_/-)
   * - Nome de set canônico + aliases
   * - Comparação por setCode (Maps.setCode)
   * - Runner com colunas em cascata e export 1:1
   *********************************************************************/

  // ==============================
  // CONFIG EXTRACTOR
  // ==============================
  const CONFIG = {
    itemSelector: '.artifact',
    idAttrCandidates: ['data-id', 'data-item-id', 'data-artifact-id'],
    levelSel: '.artifact_level',
    starsSel: '.artifact_stars .artifact_stars_normal',
    imgSel: 'img.artifact_image',
    mainBlockSel: '.artifact_primary',
    subBlockSel: '.artifact_substat_container .artifact_substat',
    ratingNowSel: '.artifact_rating > :first-child',
    ratingMaxSel: '.artifact_rating .artifact_rating_maximum',
    scrollStep: 800,
    tickMs: 180,
    idleCyclesToStop: 10,
    debug: false
  };

  // ==============================
  // STATE
  // ==============================
  const S = (window._raidExtract = window._raidExtract || {
    running: false,
    paused: false,
    timer: null,
    data: new Map(), // id -> item
    seen: new Set(),
    idleCycles: 0,
    hud: null,
    panel: null,
    seq: 0
  });

  // ==============================
  // HELPERS
  // ==============================
  const q = (sel, el=document) => el.querySelector(sel);
  const qa = (sel, el=document) => Array.from(el.querySelectorAll(sel));
  const text = el => (el ? el.textContent.trim() : '');
  function download(filename, textContent) {
    const blob = new Blob([textContent], {type:'text/plain'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
  }
  function toCSV(rows) {
    return rows.map(r=>r.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\n');
  }

  // ==============================
  // PARSER DE SET/SLOT ROBUSTO
  // ==============================
  function canonSetName(name) {
    if (!name) return '';
    let s = String(name).trim();
    // normaliza espaços duplos e capitalização leve
    s = s.replace(/\s+/g,' ').replace(/\b\w/g, m => m.toUpperCase());
    // aliases comuns
    const aliases = {
      'Stone Skin': 'StoneSkin',
      'Stoneskin': 'StoneSkin',
      'Swiftparry': 'Swift Parry',
      'Killstroke': 'Kill Stroke',
      'Divine Offence': 'Divine Offense',
      'Divine Offense': 'Divine Offense'
    };
    return aliases[s] || s;
  }
  function parseSetSlotFromSrc(src) {
    if (!src) return {set:'', slot:''};
    let clean = '';
    try { clean = decodeURI(src); } catch { clean = src; }
    // aceita "Bolster Gloves.jpg", "Bolster_Gloves.jpg" ou "Bolster-Gloves.jpg"
    const m = clean.match(/ArtifactsIcons\/(.+?)\s*[_\s-]\s*([^./]+)\.jpg/i);
    if (!m) return {set:'', slot:''};
    return { set: canonSetName(m[1].trim()), slot: m[2].trim() };
  }

  // ==============================
  // VIEWPORT (Angular CDK) + SCROLL
  // ==============================
  function getViewport() {
    const vps = qa('.cdk-virtual-scroll-viewport').filter(el => el.offsetParent !== null);
    if (vps.length) return vps.sort((a,b)=>b.clientHeight - a.clientHeight)[0];
    const cand = qa('*').filter(el => {
      const s=getComputedStyle(el);
      return (s.overflowY==='auto'||s.overflowY==='scroll') && el.scrollHeight>el.clientHeight && el.clientHeight>300 && el.offsetParent!==null;
    }).sort((a,b)=>b.clientHeight - a.clientHeight);
    return cand[0] || document.scrollingElement || document.body;
  }
  function doScroll(vp, step) {
    const before = vp.scrollTop;
    vp.scrollTop = before + step;
    setTimeout(()=>{ if (vp.scrollTop===before) vp.dispatchEvent(new WheelEvent('wheel',{deltaY:step,bubbles:true,cancelable:true})); },20);
    setTimeout(()=>{ if (vp.scrollTop===before) { vp.focus?.(); vp.dispatchEvent(new KeyboardEvent('keydown',{key:'PageDown',code:'PageDown',bubbles:true})); } },40);
  }

  // ==============================
  // EXTRAÇÃO
  // ==============================
  function getIdFrom(el) {
    for (const att of CONFIG.idAttrCandidates) {
      const v = el.getAttribute(att);
      if (v) return String(v);
    }
    const img = q(CONFIG.imgSel, el)?.getAttribute('src') || '';
    const level = text(q(CONFIG.levelSel, el)).replace(/\D+/g,'');
    const rarityClass = (el.className.match(/artifact_(\w+)/)||[])[1] || '';
    const stars = qa(CONFIG.starsSel, el).length;
    const key = [img, level, rarityClass, stars, el.innerText.slice(0,200)].join('|');
    let h=0; for (let i=0;i<key.length;i++) h=(h*31+key.charCodeAt(i))|0;
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
    const { set, slot } = parseSetSlotFromSrc(img);
    const rarity = (card.className.match(/artifact_(\w+)/)||[])[1] || '';
    const stars = qa(CONFIG.starsSel, card).length;
    const level = +(text(q(CONFIG.levelSel, card)).replace(/\D+/g,'')||0);
    const main = parseStatBlock(q(CONFIG.mainBlockSel, card));
    const subs = qa(CONFIG.subBlockSel, card).map(parseStatBlock).filter(Boolean);
    const rating_now = text(q(CONFIG.ratingNowSel, card));
    const rating_max = text(q(CONFIG.ratingMaxSel, card));
    const seq = ++S.seq;
    return { id, seq, set, slot, rarity, stars, level, main_stat:main, substats:subs, rating_now, rating_max, imgSrc:img };
  }
  function sampleOnce() {
    const cards = qa(CONFIG.itemSelector);
    let added=0;
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

  // ==============================
  // HUD
  // ==============================
  function updateHUD(vp) {
    if (!S.hud) {
      const d = document.createElement('div');
      d.style.cssText = `
        position:fixed; right:12px; bottom:12px; z-index:999998;
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
        <button id="_rx_stop">Parar+Exportar (JSON/CSV)</button>
      </div>
    `;
    q('#_rx_pause')?.addEventListener('click', pause, {once:true});
    q('#_rx_resume')?.addEventListener('click', resume, {once:true});
    q('#_rx_stop')?.addEventListener('click', stopAndExport, {once:true});
  }
  function exportJSON() {
    const arr = Array.from(S.data.values()).sort((a,b)=>a.seq-b.seq);
    download(`inventory_${arr.length}.json`, JSON.stringify(arr,null,2));
  }
  function exportCSV() {
    const rows = [
      ['id','seq','set','slot','rarity','stars','level','main_stat','main_val','main_isPct','sub1','sub1_val','sub1_isPct','sub1_rolls','sub2','sub2_val','sub2_isPct','sub2_rolls','sub3','sub3_val','sub3_isPct','sub3_rolls','sub4','sub4_val','sub4_isPct','sub4_rolls','rating_now','rating_max','imgSrc']
    ];
    for (const it of Array.from(S.data.values()).sort((a,b)=>a.seq-b.seq)) {
      const s = it.substats || [];
      rows.push([
        it.id, it.seq, it.set, it.slot, it.rarity, it.stars, it.level,
        it.main_stat?.stat || '', it.main_stat?.value ?? '', it.main_stat?.isPct ?? '',
        s[0]?.stat||'', s[0]?.value??'', s[0]?.isPct??'', s[0]?.rolls??'',
        s[1]?.stat||'', s[1]?.value??'', s[1]?.isPct??'', s[1]?.rolls??'',
        s[2]?.stat||'', s[2]?.value??'', s[2]?.isPct??'', s[2]?.rolls??'',
        s[3]?.stat||'', s[3]?.value??'', s[3]?.isPct??'', s[3]?.rolls??'',
        it.rating_now||'', it.rating_max||'', it.imgSrc||''
      ]);
    }
    download(`inventory_${S.data.size}.csv`, toCSV(rows));
  }
  function pause(){ S.paused = true; }
  function resume(){ if (!S.running) return; S.paused=false; S.idleCycles=0; loop(); }
  function stopAndExport(){
    S.running=false; clearInterval(S.timer); S.timer=null;
    try { exportJSON(); exportCSV(); } catch(e){ console.error(e); }
    if (S.hud) S.hud.remove(), S.hud=null;
    console.log('[extract] done', S.data.size);
  }
  function tick(vp) {
    if (!S.running || S.paused) return;
    const added = sampleOnce();
    if (CONFIG.debug && added) console.log('[extract] +', added, 'total', S.data.size);
    S.idleCycles = added ? 0 : (S.idleCycles + 1);
    if (S.idleCycles >= CONFIG.idleCyclesToStop) { stopAndExport(); return; }
    doScroll(vp, CONFIG.scrollStep);
    updateHUD(vp);
  }
  function loop() {
    if (S.timer) clearInterval(S.timer);
    const vp = getViewport();
    updateHUD(vp);
    S.timer = setInterval(()=>tick(vp), CONFIG.tickMs);
  }

  // ==============================
  // RUNNER
  // ==============================
  function toRawGitUrl(url) {
    try {
      const u = new URL(url);
      if (u.hostname === 'github.com') {
        const parts = u.pathname.split('/').filter(Boolean);
        const [user, repo, , branch, ...rest] = parts;
        return `https://raw.githubusercontent.com/${user}/${repo}/${branch}/${rest.join('/')}`;
      }
      return url;
    } catch { return url; }
  }
  async function fetchText(url) {
    const res = await fetch(toRawGitUrl(url));
    if (!res.ok) throw new Error(`Falha ao baixar: ${url} (${res.status})`);
    return res.text();
  }
  function normTier(s) {
    const t=String(s||'').trim().toUpperCase();
    if (['SUPER-ENDGAME','SUPERENDGAME','S+','SPLUS','S_PLUS'].includes(t)) return 'SUPER-ENDGAME';
    if (['ENDGAME','S'].includes(t)) return 'ENDGAME';
    if (['MIDGAME','MID'].includes(t)) return 'MIDGAME';
    throw new Error(`Tier inválido: ${s}`);
  }
  function splitNameProfile(rawName){ const m=String(rawName).trim().match(/^(.*?)(?:_(OFF|DEF|HYB))?$/i); return { base:m?.[1]?.trim()||String(rawName).trim(), profile:(m?.[2]?.toUpperCase()||'DEF') }; }
  function parseConfigLine(line, defaults={toprowMin:3,toprowMax:7}){
    const clean=line.split('#')[0].trim(); if(!clean) return null;
    const parts=clean.split('|').map(s=>s.trim()).filter(Boolean);
    if (parts.length<4) throw new Error(`Linha inválida: ${line}`);
    const [nameRaw, codeRaw, tierRaw, qtyRaw, extraRaw=''] = parts;
    const {base:setName, profile} = splitNameProfile(nameRaw);
    const code = isNaN(Number(codeRaw)) ? String(codeRaw) : Number(codeRaw);
    const tierTarget = normTier(tierRaw);
    const targetSets = (String(qtyRaw).toUpperCase()==='AUTO') ? 'AUTO' : Number(qtyRaw);
    if (targetSets!=='AUTO' && (!Number.isFinite(targetSets)||targetSets<0)) throw new Error(`Quantidade inválida: ${line}`);
    let tmin=defaults.toprowMin, tmax=defaults.toprowMax;
    if (/TOPROW/i.test(extraRaw)) {
      const m=extraRaw.match(/TOPROW\s+(\d+)\s*[-–]\s*(\d+)/i);
      if (!m) throw new Error(`Sintaxe TOPROW inválida "${extraRaw}"`);
      tmin=Number(m[1]); tmax=Number(m[2]); if (!(tmin>=0&&tmax>=tmin)) throw new Error(`Faixa inválida ${tmin}-${tmax}`);
    }
    return { setDisplay:nameRaw, setName, profile, code, tierTarget, targetSets, toprow:{min:tmin,max:tmax} };
  }
  function parseConfigTxt(text, defaults={toprowMin:3,toprowMax:7}){
    const entries=[]; for (const raw of String(text).split(/\r?\n/)){ const line=raw.trim(); if(!line||line.startsWith('#')) continue; const e=parseConfigLine(line,defaults); if(e) entries.push(e); }
    return { entries, defaults };
  }
  function parseSellFile(hsf){ const s=typeof hsf==='string'?hsf.replace(/^\uFEFF/,'').trim():hsf; if(typeof s==='string') return JSON.parse(s); if(typeof s==='object'&&s) return s; throw new Error('Sell file inválido'); }

  // maps — ajuste conforme seus IDs
  const Maps = {
    setCode: { 'Lethal':46, 'Savage':19, 'StoneSkin':48, 'Bolster':51, 'Regeneration':15, 'Immortal':30, 'Destroy':24, 'Stun':21, 'Provoke':23, 'Perception':38, 'Resistance':32, 'Speed':4 },
    slotCode: { 'Weapon':0, 'Helm':1, 'Shield':2, 'Gloves':3, 'Chest':4, 'Boots':5 },
    statId: { 'SPD':6, 'C.RATE%':1, 'C.DMG%':8, 'ATK%':4, 'HP%':2, 'DEF%':3, 'ACC':5, 'RES':7 },
    setSizeByName: { 'Savage':4, 'Lethal':2, 'StoneSkin':2, 'Bolster':2, 'Regeneration':2, 'Immortal':2, 'Destroy':2, 'Stun':2, 'Provoke':2, 'Perception':2, 'Resistance':2, 'Speed':2 }
  };
  function getSetSize(setName){ return Maps.setSizeByName[setName] ?? 2; }

  function normStatName(n){
    const s=String(n||'').toUpperCase().replace(/\s+/g,'');
    if (/SPD/.test(s)) return 'SPD';
    if (/C(\.|)RATE/.test(s)) return 'C.RATE%';
    if (/C(\.|)DMG/.test(s)) return 'C.DMG%';
    if (/ATK%/.test(s)) return 'ATK%';
    if (/HP%/.test(s))  return 'HP%';
    if (/DEF%/.test(s)) return 'DEF%';
    if (/ACC/.test(s))  return 'ACC';
    if (/RES/.test(s))  return 'RES';
    return n;
  }
  function normalizeInventoryItem(raw){
    const main = raw.main_stat ? { stat: normStatName(raw.main_stat.stat), value: raw.main_stat.value, isPct: !!raw.main_stat.isPct } : null;
    const subs = (raw.substats||[]).map(s=>({ stat: normStatName(s.stat), value: s.value, isPct: !!s.isPct, rolls: s.rolls||0 }));
    const setCanon = canonSetName(raw.set||'');
    const setCode = Maps.setCode[setCanon];
    return { id:String(raw.id), seq:Number(raw.seq||0), set:setCanon, setCode, slot:String(raw.slot||''), rarity:String(raw.rarity||''), level:Number(raw.level||0), main, subs, rating_now:raw.rating_now||'', rating_max:raw.rating_max||'', imgSrc:raw.imgSrc||'' };
  }

  function itemHasSub(item, statId, cond, value, isFlat){
    if (!Maps.statId || statId==null) return true;
    const wanted = Object.entries(Maps.statId).find(([k,v])=>v===statId)?.[0];
    if (!wanted) return true;
    const sub = item.subs.find(s=>normStatName(s.stat)===wanted && (!!isFlat ? !s.isPct : true));
    if (!sub) return false;
    const v=Number(sub.value||0);
    switch (cond) { case '>=': return v>=value; case '<=': return v<=value; case '==': return v==value; default: return v>=value; }
  }
  function matchRule(item, rule){
    if (rule.Use===false) return false;
    // Set por código
    if (Array.isArray(rule.ArtifactSet)&&rule.ArtifactSet.length){
      if (item.setCode==null || !rule.ArtifactSet.includes(item.setCode)) return false;
    }
    // Slot por código
    if (Array.isArray(rule.ArtifactType)&&rule.ArtifactType.length){
      const code = Maps.slotCode[item.slot];
      if (code==null || !rule.ArtifactType.includes(code)) return false;
    }
    if (rule.MainStatID!=null){
      if (!item.main) return false;
      const itemMainId = Maps.statId[item.main.stat];
      if (itemMainId!=null && itemMainId !== rule.MainStatID) return false;
    }
    const subs = Array.isArray(rule.Substats) ? rule.Substats.filter(s => s && s.ID!=null && s.NotAvailable!==true) : [];
    if (subs.length){
      if (rule.IsRuleTypeAND){
        for (const s of subs) { if (!itemHasSub(item, s.ID, s.Condition||'>=', Number(s.Value||0), !!s.IsFlat)) return false; }
      } else {
        let ok=false; for (const s of subs){ if (itemHasSub(item, s.ID, s.Condition||'>=', Number(s.Value||0), !!s.IsFlat)) { ok=true; break; } }
        if (!ok) return false;
      }
    }
    return true;
  }
  function specificityScore(rule){
    let s=0; if (rule.ArtifactSet?.length) s+=2; if (rule.ArtifactType?.length) s+=2;
    if (rule.MainStatID!=null) s+=2; if (rule.Substats?.length) s+=rule.Substats.filter(x=>x&&x.ID!=null && x.NotAvailable!==true).length;
    if (rule.Rank!=null) s+=1; if (rule.Rarity!=null) s+=1; return s;
  }

  // classifica por tier e devolve AÇÕES por tier (S+, S, Mid)
  function evaluateByTiers(item, sellFiles){
    const tiers = [
      {name:'SUPER-ENDGAME',rules:sellFiles.super},
      {name:'ENDGAME',rules:sellFiles.end},
      {name:'MIDGAME',rules:sellFiles.mid},
    ];
    const actions = { super:'NONE', end:'NONE', mid:'NONE' };
    const bestByTier = {};

    for (const t of tiers) {
      let best = {auto:'NONE', spec:-1, keep:false, rule:null};
      if (Array.isArray(t.rules)) {
        for (const r of t.rules) {
          if (!matchRule(item, r)) continue;
          const spec = specificityScore(r);
          const keep = !!r.Keep;
          const auto = keep ? 'KEEP' : 'SELL';
          if ((keep && !best.keep) || (keep===best.keep && spec>best.spec)) {
            best = {auto, spec, keep, rule:r};
          }
        }
      }
      if (t.name==='SUPER-ENDGAME') actions.super = best.auto, bestByTier.super = best;
      if (t.name==='ENDGAME') actions.end = best.auto, bestByTier.end = best;
      if (t.name==='MIDGAME') actions.mid = best.auto, bestByTier.mid = best;
    }

    // CASCATA: KEEP em S+ ⇒ KEEP também em S e Mid; KEEP em S ⇒ KEEP em Mid
    if (actions.super==='KEEP') { actions.end='KEEP'; actions.mid='KEEP'; }
    else if (actions.end==='KEEP') { actions.mid='KEEP'; }

    // winner_tier: primeiro tier onde há KEEP; senão primeiro com SELL; senão None
    let winner = 'None', auto_action = 'KEEP';
    if (actions.super==='KEEP') winner='SUPER-ENDGAME';
    else if (actions.end==='KEEP') winner='ENDGAME';
    else if (actions.mid==='KEEP') winner='MIDGAME';
    else if (actions.super==='SELL') { winner='SUPER-ENDGAME'; auto_action='SELL'; }
    else if (actions.end==='SELL')   { winner='ENDGAME'; auto_action='SELL'; }
    else if (actions.mid==='SELL')   { winner='MIDGAME'; auto_action='SELL'; }
    else auto_action = 'KEEP';

    return { actions, winner_tier: winner, auto_action };
  }

  function isMain(it,stat){ return it.main && normStatName(it.main.stat)===stat; }
  const Gates = {
    DEF: { gloves: it=>isMain(it,'HP%')||isMain(it,'DEF%'), chest: it=>isMain(it,'HP%')||isMain(it,'DEF%'), boots: it=>isMain(it,'SPD') },
    OFF: { gloves: it=>isMain(it,'C.DMG%')||isMain(it,'C.RATE%'), chest: it=>isMain(it,'ATK%')||isMain(it,'HP%')||isMain(it,'DEF%'), boots: it=>isMain(it,'SPD') },
    HYB: { gloves: _=>true, chest: _=>true, boots: it=>isMain(it,'SPD') }
  };
  function aggregateBySlot(items){
    const top={Weapon:[],Helm:[],Shield:[]}, low={Gloves:[],Chest:[],Boots:[]};
    for (const it of items) { if (top[it.slot]) top[it.slot].push(it); else if (low[it.slot]) low[it.slot].push(it); }
    return {top,low};
  }
  function allocateTopRow(topCounts, K, win) {
    const need=3*K;
    const avail = { Weapon: topCounts.Weapon.length, Helm: topCounts.Helm.length, Shield: topCounts.Shield.length };
    const minSum=win.min*3, maxSum=win.max*3;
    if (avail.Weapon+avail.Helm+avail.Shield < need) return null;
    if (!(minSum<=need && need<=maxSum)) return null;
    let alloc={Weapon:win.min,Helm:win.min,Shield:win.min}; let left=need - (win.min*3);
    const order=['Weapon','Helm','Shield'].sort((a,b)=>avail[b]-avail[a]);
    while (left>0){
      let progressed=false;
      for (const s of order){
        if (alloc[s] < win.max && alloc[s] < avail[s]) { alloc[s]++; left--; progressed=true; if (left===0) break; }
      }
      if (!progressed) break;
    }
    if (left>0) return null;
    return alloc;
  }
  function closeMinimumsForEntry(entry, poolByTier) {
    const order = entry.tierTarget==='SUPER-ENDGAME' ? ['SUPER-ENDGAME','ENDGAME','MIDGAME'] :
                  entry.tierTarget==='ENDGAME'       ? ['ENDGAME','MIDGAME'] : ['MIDGAME'];
    const result = { set:entry.setDisplay, profile:entry.profile, target:entry.targetSets, closed:{'SUPER-ENDGAME':0,'ENDGAME':0,'MIDGAME':0}, deficits:{}, reservedIds:new Set() };
    const K = entry.targetSets==='AUTO' ? 0 : Number(entry.targetSets||0);
    if (K===0) return result;
    let remaining = K;
    for (const tier of order){
      const items = poolByTier[tier] || [];
      if (!items.length) continue;
      const {top,low} = aggregateBySlot(items);
      const allocTop = allocateTopRow({Weapon:top.Weapon,Helm:top.Helm,Shield:top.Shield}, remaining, entry.toprow);
      if (!allocTop){ result.deficits[`top_${tier}`]='Top row insuficiente'; continue; }
      const g = Gates[entry.profile] || Gates.DEF;
      const okGl = low.Gloves.filter(g.gloves);
      const okCh = low.Chest.filter(g.chest);
      const okBt = low.Boots.filter(g.boots);
      if (okGl.length<remaining || okCh.length<remaining || okBt.length<remaining) {
        const d=[]; if (okGl.length<remaining) d.push(`Gloves (${okGl.length}/${remaining})`);
        if (okCh.length<remaining) d.push(`Chest (${okCh.length}/${remaining})`);
        if (okBt.length<remaining) d.push(`Boots (${okBt.length}/${remaining})`);
        result.deficits[`lower_${tier}`]=d.join(', ');
        continue;
      }
      const reserved=new Set();
      function take(arr,n){ const out=[]; for (const it of arr){ if (reserved.has(it.id)) continue; out.push(it); reserved.add(it.id); if (out.length===n) break; } return out; }
      const useW=take(top.Weapon,allocTop.Weapon), useH=take(top.Helm,allocTop.Helm), useS=take(top.Shield,allocTop.Shield);
      const useG=take(okGl,remaining),            useC=take(okCh,remaining),           useB=take(okBt,remaining);
      for (const it of [...useW,...useH,...useS,...useG,...useC,...useB]) result.reservedIds.add(it.id);
      result.closed[tier]+=remaining; remaining=0; break;
    }
    if (remaining>0) result.deficits.final=`faltaram ${remaining} set(s)`;
    return result;
  }

  async function runMiniRunner({configUrl, superUrl, endUrl, midUrl, inventory}) {
    const [cfgTxt, superTxt, endTxt, midTxt] = await Promise.all([fetchText(configUrl), fetchText(superUrl), fetchText(endUrl), fetchText(midUrl)]);
    const {entries} = parseConfigTxt(cfgTxt, {toprowMin:3,toprowMax:7});
    const sellSuper = parseSellFile(superTxt), sellEnd=parseSellFile(endTxt), sellMid=parseSellFile(midTxt);
    const sellFiles = { super: Array.isArray(sellSuper)?sellSuper:[], end: Array.isArray(sellEnd)?sellEnd:[], mid: Array.isArray(sellMid)?sellMid:[] };

    // normaliza e classifica (mantém ordem por seq)
    const items = inventory.map(normalizeInventoryItem).sort((a,b)=>a.seq-b.seq);

    // logs/avisos
    const warnNoSet = items.filter(i => !i.set).slice(0,5).map(i=>i.id);
    const warnNoSlot= items.filter(i => !i.slot).slice(0,5).map(i=>i.id);
    const unknownCodes = new Set(items.filter(i => i.set && i.setCode==null).map(i=>i.set));

    // avaliação por tier (cascata)
    for (const it of items) {
      const ev = evaluateByTiers(it, sellFiles);
      it.action_super = ev.actions.super;
      it.action_end   = ev.actions.end;
      it.action_mid   = ev.actions.mid;
      it.winner_tier  = ev.winner_tier;
      it.auto_action  = ev.auto_action;
      it.reserved_by_set = '';
      it.set_completion_tag = '';
      it.selected_for_sell = ''; // preenchido depois
      it.keep_override = '';
      it.notes = '';
    }

    // pools por setCode/tier para mínimos (apenas sets presentes no config, via code)
    const entriesByCode = {};
    for (const e of entries) entriesByCode[String(e.code)] = e;

    const poolsByCodeTier = {}; // { [code]: { 'SUPER-ENDGAME':[], 'ENDGAME':[], 'MIDGAME':[] } }
    for (const it of items) {
      const code = it.setCode;
      if (code==null || !entriesByCode[String(code)]) continue;
      const t = it.winner_tier || 'None';
      if (!poolsByCodeTier[code]) poolsByCodeTier[code] = { 'SUPER-ENDGAME':[], 'ENDGAME':[], 'MIDGAME':[] };
      if (t==='SUPER-ENDGAME'||t==='ENDGAME'||t==='MIDGAME') poolsByCodeTier[code][t].push(it);
    }

    // fecha mínimos
    const summaries=[], reservedGlobal=new Set();
    for (const e of entries) {
      const pools = poolsByCodeTier[String(e.code)] || { 'SUPER-ENDGAME':[], 'ENDGAME':[], 'MIDGAME':[] };
      const res = closeMinimumsForEntry(e, pools);
      summaries.push({
        set: e.setName, perfil: e.profile, target: e.targetSets,
        fechados_Splus: res.closed['SUPER-ENDGAME']||0,
        fechados_S:     res.closed['ENDGAME']||0,
        fechados_Mid:   res.closed['MIDGAME']||0,
        deficits: JSON.stringify(res.deficits||{})
      });
      for (const id of res.reservedIds) reservedGlobal.add(id);
      for (const it of items) {
        if (res.reservedIds.has(it.id)) {
          it.reserved_by_set = `${e.setName}_${e.profile}`;
          const tag = res.closed['SUPER-ENDGAME'] ? 'SUPER-ENDGAME' : res.closed['ENDGAME'] ? 'ENDGAME' : res.closed['MIDGAME'] ? 'MIDGAME' : '';
          it.set_completion_tag = tag ? `${e.setName}_${e.profile}:${tag}` : it.set_completion_tag;
        }
      }
    }

    // selected_for_sell (respeitando reservas)
    for (const it of items) {
      // regra “sets fora do config entram no scan geral Endgame”: se SELL no end → marcar
      if (!entriesByCode[String(it.setCode)]) {
        it.selected_for_sell = (it.action_end==='SELL') ? 'SELL' : '';
      } else {
        it.selected_for_sell = (it.auto_action==='SELL' && !reservedGlobal.has(it.id)) ? 'SELL' : '';
      }
    }

    // CSVs (revisado 1:1 + summary)
    const invCsv = toCSV([
      ['id','seq','set','setCode','slot','level','rarity','main','main_val','subs','action_super','action_end','action_mid','winner_tier','auto_action','reserved_by_set','set_completion_tag','selected_for_sell','keep_override','notes'],
      ...items.map(it=>[
        it.id, it.seq, it.set, it.setCode??'', it.slot, it.level, it.rarity,
        it.main?.stat||'', it.main?.value??'',
        (it.subs||[]).map(s=>`${s.stat}:${s.value}`).join('; '),
        it.action_super, it.action_end, it.action_mid,
        it.winner_tier, it.auto_action, it.reserved_by_set, it.set_completion_tag,
        it.selected_for_sell, it.keep_override, it.notes
      ])
    ]);

    const summaryCsv = toCSV([
      ['set','perfil','target','fechados_Splus','fechados_S','fechados_Mid','deficits'],
      ...summaries.map(s=>[s.set,s.perfil,s.target,s.fechados_Splus,s.fechados_S,s.fechados_Mid,s.deficits])
    ]);

    // logs para o painel
    const log = [];
    if (warnNoSet.length) log.push(`⚠️ Itens sem SET detectado (amostra): ${warnNoSet.join(', ')}`);
    if (warnNoSlot.length) log.push(`⚠️ Itens sem SLOT detectado (amostra): ${warnNoSlot.join(', ')}`);
    if (unknownCodes.size) log.push(`ℹ️ Sets sem setCode mapeado: ${Array.from(unknownCodes).slice(0,10).join(', ')}...`);
    log.push(`Itens extraídos: ${inventory.length} | Revisado: ${items.length} (deve bater)`);

    return { summaryCsv, inventoryCsv: invCsv, items, summaries, log: log.join('\n') };
  }

  // ==============================
  // UI PAINEL
  // ==============================
  function ensurePanel() {
    if (S.panel) return S.panel;
    const wrap = document.createElement('div');
    wrap.style.cssText = `
      position:fixed; right:12px; bottom:110px; z-index:999999;
      width:380px; max-height:70vh; overflow:auto;
      background:#0E1016; color:#EDEFF6; border:1px solid #25293c;
      border-radius:10px; box-shadow:0 8px 24px rgba(0,0,0,.35); font:12px/1.4 system-ui,Segoe UI,Roboto;
    `;
    wrap.innerHTML = `
      <div style="padding:10px 12px; position:sticky; top:0; background:#0E1016; border-bottom:1px solid #1a1f2e;">
        <b>RAID – Extractor & Runner v2</b>
        <button id="_rx_close" style="float:right; background:#22273a;color:#fff;border:0;border-radius:6px;padding:2px 6px;cursor:pointer">×</button>
      </div>
      <div style="padding:10px 12px;">
        <div style="margin-bottom:10px;opacity:.9">Itens coletados: <b id="_rx_count">0</b></div>

        <details open style="margin-bottom:8px">
          <summary><b>URLs (Config & Sell Files)</b></summary>
          <div style="display:grid;gap:6px;margin-top:6px">
            <label>Config.txt
              <input id="_rx_cfg" style="width:100%" value="https://github.com/odisseumuadib/Gibs-Gamming/blob/RAID-SL/Raid-SL/Raid_filter-Config.txt">
            </label>
            <label>Super-Endgame
              <input id="_rx_super" style="width:100%" value="https://github.com/odisseumuadib/Gibs-Gamming/blob/RAID-SL/Raid-SL/Endgame%20Sell%20File%20-%20v8_1%20-%20by%20Lil.hsf">
            </label>
            <label>Endgame
              <input id="_rx_end" style="width:100%" value="https://github.com/odisseumuadib/Gibs-Gamming/blob/RAID-SL/Raid-SL/Lategame%20Sell%20File%20-%20v8_1%20-%20by%20Lil.hsf">
            </label>
            <label>Midgame
              <input id="_rx_mid" style="width:100%" value="https://github.com/odisseumuadib/Gibs-Gamming/blob/RAID-SL/Raid-SL/Midgame%20Sell%20file%20-%20by%20Ashayagar.hsf">
            </label>
          </div>
        </details>

        <div style="display:grid;gap:8px">
          <button id="_rx_start" style="background:#2e7d32;border:0;color:#fff;padding:8px;border-radius:8px;cursor:pointer">▶️ Iniciar Extração</button>
          <button id="_rx_pause2" style="background:#555;border:0;color:#fff;padding:6px;border-radius:8px;cursor:pointer">⏸️ Pausar</button>
          <button id="_rx_resume2" style="background:#4c7bd9;border:0;color:#fff;padding:6px;border-radius:8px;cursor:pointer">⏯️ Retomar</button>
          <button id="_rx_stop2" style="background:#d9534f;border:0;color:#fff;padding:8px;border-radius:8px;cursor:pointer">⏹️ Parar+Export (JSON/CSV)</button>
          <hr style="border-color:#1a1f2e">
          <button id="_rx_classify" style="background:#8e44ad;border:0;color:#fff;padding:10px;border-radius:8px;cursor:pointer">🧠 Classificar + Exportar CSVs</button>
          <div id="_rx_log" style="white-space:pre-wrap;background:#0b0d14;border:1px solid #1a1f2e;border-radius:6px;padding:8px;min-height:80px;max-height:220px;overflow:auto"></div>
        </div>
      </div>
    `;
    document.body.appendChild(wrap);
    S.panel = wrap;

    q('#_rx_close', wrap).onclick = ()=>{ wrap.remove(); S.panel=null; };
    q('#_rx_start', wrap).onclick = ()=>{
      if (S.running) return;
      S.running=true; S.paused=false; S.idleCycles=0; loop();
    };
    q('#_rx_pause2', wrap).onclick = ()=> pause();
    q('#_rx_resume2', wrap).onclick = ()=> resume();
    q('#_rx_stop2', wrap).onclick = ()=> stopAndExport();
    q('#_rx_classify', wrap).onclick = async ()=>{
      const logEl = q('#_rx_log', wrap);
      const count = S.data.size;
      if (!count) { logEl.textContent = 'Nenhum item coletado ainda. Rode a extração primeiro.'; return; }
      logEl.textContent = 'Baixando arquivos de configuração...\n';
      try {
        const cfg = q('#_rx_cfg', wrap).value.trim();
        const sU  = q('#_rx_super', wrap).value.trim();
        const eU  = q('#_rx_end', wrap).value.trim();
        const mU  = q('#_rx_mid', wrap).value.trim();
        const inv = Array.from(S.data.values()).sort((a,b)=>a.seq-b.seq);

        const { summaryCsv, inventoryCsv, log } = await runMiniRunner({
          configUrl: cfg, superUrl: sU, endUrl: eU, midUrl: mU, inventory: inv
        });
        download('summary.csv', summaryCsv);
        download('inventory_review.csv', inventoryCsv);
        logEl.textContent = (log ? (log+'\n') : '') + `✅ Exportados: summary.csv e inventory_review.csv\nItens: ${count}\n`;
      } catch (err) {
        logEl.textContent += 'Erro: ' + (err?.message || err) + '\n';
        console.error(err);
      }
    };

    const cnt = q('#_rx_count', wrap);
    const interval = setInterval(()=>{ if (!document.body.contains(wrap)) { clearInterval(interval); return; } cnt.textContent=String(S.data.size); }, 500);

    return wrap;
  }

  // ==============================
  // PUBLIC API
  // ==============================
  window.RaidOptimizerExtractor = {
    start(){
      ensurePanel();
      if (S.running) return console.warn('Extractor já está rodando.');
      S.running = true; S.paused = false; S.idleCycles = 0; loop();
      console.log('▶️ Extractor iniciado.');
    },
    pause, resume,
    stop: stopAndExport,
    data: () => Array.from(S.data.values()).sort((a,b)=>a.seq-b.seq),
    clear(){
      S.running=false; clearInterval(S.timer); S.timer=null;
      S.data.clear(); S.seen.clear(); if (S.hud) S.hud.remove(), S.hud=null;
      S.seq=0;
      console.log('limpo.');
    },
    ui: ensurePanel
  };

  // inicia painel
  ensurePanel();
})();
