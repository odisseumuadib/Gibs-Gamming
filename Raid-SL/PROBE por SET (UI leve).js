(() => {
  // =========================
  // PROBE por SET (UI leve)
  // - Lista sets e conta itens
  // - Scan por tier (S+, S, Mid) usando sell files
  // - Resultado: SELL/KEEP + breakdown por slot (mantidos)
  // =========================

  // --- acesso ao inventário já extraído
  const EX = window._raidExtract || {};
  if (!EX.data || EX.data.size === 0) {
    console.warn('Nenhum item encontrado. Rode a extração antes.');
  }

  // --- utils
  const q = (s, el=document)=>el.querySelector(s);
  const qa = (s, el=document)=>Array.from(el.querySelectorAll(s));
  const text = el=>el?el.textContent.trim():'';

  function canonSetName(name) {
    if (!name) return '';
    let s = String(name).trim().replace(/\s+/g,' ').replace(/\b\w/g, m => m.toUpperCase());
    const alias = {
      'Stone Skin':'StoneSkin',
      'Stoneskin':'StoneSkin',
      'Swiftparry':'Swift Parry',
      'Killstroke':'Kill Stroke',
      'Divine Offence':'Divine Offense',
      'Divine Offense':'Divine Offense',
    };
    return alias[s] || s;
  }
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

  // --- mapas (adicione códigos novos aqui quando precisar)
  const Maps = {
    setCode: {
      'Lethal':46, 'Savage':19, 'StoneSkin':48, 'Bolster':51,
      'Regeneration':15, 'Immortal':30, 'Destroy':24, 'Stun':21, 'Provoke':23,
      'Perception':38, 'Resistance':32, 'Speed':4,
      // Ex.: 'Chronophage': 99,  // coloque o code quando soubermos
    },
    slotCode: { 'Weapon':0, 'Helm':1, 'Shield':2, 'Gloves':3, 'Chest':4, 'Boots':5 },
    statId:   { 'SPD':6, 'C.RATE%':1, 'C.DMG%':8, 'ATK%':4, 'HP%':2, 'DEF%':3, 'ACC':5, 'RES':7 },
  };

  // --- normaliza o inventário do extractor
  const inventory = Array.from(EX.data.values())
    .sort((a,b)=>a.seq-b.seq)
    .map(raw=>{
      const set = canonSetName(raw.set||'');
      const setCode = Maps.setCode[set];
      const subs = (raw.substats||[]).map(s=>({ stat:normStatName(s.stat), value:s.value, isPct:!!s.isPct, rolls:s.rolls||0 }));
      const main = raw.main_stat ? { stat: normStatName(raw.main_stat.stat), value: raw.main_stat.value, isPct: !!raw.main_stat.isPct } : null;
      return {
        id:String(raw.id), seq:+raw.seq||0, set, setCode, slot:String(raw.slot||''),
        rarity:String(raw.rarity||''), stars:+raw.stars||'', level:+raw.level||0,
        main, subs
      };
    });

  // --- agrupa por set
  const setsList = (() => {
    const m = new Map();
    for (const it of inventory) {
      const k = it.set || '(sem set)';
      m.set(k, (m.get(k)||0)+1);
    }
    return Array.from(m.entries()).sort((a,b)=>b[1]-a[1]);
  })();

  // --- fetch helpers (aceita link do GitHub normal)
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

  // --- leitura de sell files
  async function loadSellFiles({superUrl, endUrl, midUrl}) {
    const [s,e,m] = await Promise.all([fetchText(superUrl), fetchText(endUrl), fetchText(midUrl)]);
    const parse = t => {
      const s = String(t||'').replace(/^\uFEFF/, '').trim();
      return JSON.parse(s);
    };
    return { super: parse(s), end: parse(e), mid: parse(m) };
  }

  // --- match das regras (prova simples)
  function itemHasSub(item, statId, cond, value, isFlat){
    const wanted = Object.entries(Maps.statId).find(([k,v])=>v===statId)?.[0];
    if (!wanted) return true; // se não sabemos mapear, não bloqueia
    const sub = item.subs.find(s=>normStatName(s.stat)===wanted && (!!isFlat ? !s.isPct : true));
    if (!sub) return false;
    const v=Number(sub.value||0);
    switch (cond) { case '>=': return v>=value; case '<=': return v<=value; case '==': return v==value; default: return v>=value; }
  }
  function matchRule(item, rule){
    if (rule.Use===false) return false;
    // Set: por código se disponível; se não soubermos o code, tentamos nome exato via fallbackName (opcional)
    if (Array.isArray(rule.ArtifactSet) && rule.ArtifactSet.length){
      if (item.setCode==null) return false; // sem code = não arriscamos casar set específico
      if (!rule.ArtifactSet.includes(item.setCode)) return false;
    }
    // Slot
    if (Array.isArray(rule.ArtifactType)&&rule.ArtifactType.length){
      const code = Maps.slotCode[item.slot];
      if (code==null || !rule.ArtifactType.includes(code)) return false;
    }
    // Main
    if (rule.MainStatID!=null){
      if (!item.main) return false;
      const itemMainId = Maps.statId[item.main.stat];
      if (itemMainId!=null && itemMainId !== rule.MainStatID) return false;
    }
    // Subs
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

  // --- decisão por tier (prova): KEEP se bater em qualquer keep; senão SELL se bater em qualquer sell; senão KEEP
  function decideTier(item, rules){
    let hitKeep = false, hitSell = false;
    for (const r of rules){
      if (!matchRule(item, r)) continue;
      if (r.Keep) hitKeep = true;
      else hitSell = true;
      // prioridade visual: achou Keep, pode encerrar cedo
      if (hitKeep) break;
    }
    if (hitKeep) return 'KEEP';
    if (hitSell) return 'SELL';
    return 'KEEP';
  }

  // --- scan por set/tier
  function scanSet(setName, tierRules) {
    const name = canonSetName(setName);
    const items = inventory.filter(i => i.set === name);
    const res = { set:name, total:items.length, keep:0, sell:0, bySlotKeep:{Weapon:0,Helm:0,Shield:0,Gloves:0,Chest:0,Boots:0} };
    for (const it of items) {
      const action = decideTier(it, tierRules);
      if (action === 'SELL') res.sell++;
      else {
        res.keep++;
        if (res.bySlotKeep[it.slot]!=null) res.bySlotKeep[it.slot]++;
      }
    }
    return res;
  }

  // --- UI (painel simples)
  function ensurePanel() {
    let wrap = document.getElementById('_probe_panel');
    if (wrap) return wrap;
    wrap = document.createElement('div');
    wrap.id = '_probe_panel';
    wrap.style.cssText = `
      position:fixed; right:12px; bottom:12px; z-index:999999;
      width:380px; max-height:80vh; overflow:auto;
      background:#0E1016; color:#EDEFF6; border:1px solid #25293c;
      border-radius:10px; box-shadow:0 8px 24px rgba(0,0,0,.35); font:12px/1.4 system-ui,Segoe UI,Roboto;
    `;
    wrap.innerHTML = `
      <div style="padding:10px 12px; position:sticky; top:0; background:#0E1016; border-bottom:1px solid #1a1f2e;">
        <b>RAID – Set Scanner (prova)</b>
        <button id="_probe_close" style="float:right; background:#22273a;color:#fff;border:0;border-radius:6px;padding:2px 6px;cursor:pointer">×</button>
      </div>
      <div style="padding:10px 12px; display:grid; gap:8px;">
        <div>Sets encontrados: <b id="_probe_sets_count">0</b></div>
        <div id="_probe_sets_list" style="border:1px solid #1a1f2e; border-radius:6px; padding:8px; max-height:180px; overflow:auto;"></div>
        <div style="display:grid;gap:6px">
          <label>Super-Endgame URL <input id="_probe_su" style="width:100%" value="https://github.com/odisseumuadib/Gibs-Gamming/blob/RAID-SL/Raid-SL/Endgame%20Sell%20File%20-%20v8_1%20-%20by%20Lil.hsf"></label>
          <label>Endgame URL <input id="_probe_en" style="width:100%" value="https://github.com/odisseumuadib/Gibs-Gamming/blob/RAID-SL/Raid-SL/Lategame%20Sell%20File%20-%20v8_1%20-%20by%20Lil.hsf"></label>
          <label>Midgame URL <input id="_probe_mi" style="width:100%" value="https://github.com/odisseumuadib/Gibs-Gamming/blob/RAID-SL/Raid-SL/Midgame%20Sell%20file%20-%20by%20Ashayagar.hsf"></label>
        </div>
        <div style="display:flex; gap:6px; flex-wrap:wrap;">
          <button id="_probe_load" style="background:#4c7bd9;border:0;color:#fff;padding:8px 10px;border-radius:8px;cursor:pointer">Baixar Sell Files</button>
          <button id="_probe_scan_su" style="background:#8e44ad;border:0;color:#fff;padding:8px 10px;border-radius:8px;cursor:pointer">Scan S+</button>
          <button id="_probe_scan_en" style="background:#2e7d32;border:0;color:#fff;padding:8px 10px;border-radius:8px;cursor:pointer">Scan S</button>
          <button id="_probe_scan_mi" style="background:#936c00;border:0;color:#fff;padding:8px 10px;border-radius:8px;cursor:pointer">Scan Mid</button>
          <button id="_probe_skip" style="background:#555;border:0;color:#fff;padding:8px 10px;border-radius:8px;cursor:pointer">Skip</button>
          <button id="_probe_next" style="background:#d9534f;border:0;color:#fff;padding:8px 10px;border-radius:8px;cursor:pointer">Next Set</button>
        </div>
        <div id="_probe_log" style="white-space:pre-wrap;background:#0b0d14;border:1px solid #1a1f2e;border-radius:6px;padding:8px;min-height:100px;max-height:240px;overflow:auto"></div>
      </div>
    `;
    document.body.appendChild(wrap);
    q('#_probe_close', wrap).onclick = ()=>wrap.remove();
    return wrap;
  }

  const UI = ensurePanel();
  const listBox = q('#_probe_sets_list', UI);
  const countEl = q('#_probe_sets_count', UI);
  const logEl = q('#_probe_log', UI);

  // render lista de sets
  let idx = 0;
  const sets = setsList.map(([name,count])=>({name, count}));
  countEl.textContent = String(sets.length);
  function renderList() {
    listBox.innerHTML = sets.map((s,i)=> {
      const sel = (i===idx) ? 'background:#1a1f2e;border-color:#3a3f5a;' : '';
      return `<div data-i="${i}" style="display:flex;justify-content:space-between;align-items:center;border:1px solid #1a1f2e;border-radius:5px;padding:6px 8px;margin-bottom:6px;${sel}">
        <span>${s.name}</span><span style="opacity:.85">${s.count}</span>
      </div>`;
    }).join('');
    qa('div[data-i]', listBox).forEach(el=>{
      el.onclick = ()=>{ idx = +el.getAttribute('data-i'); renderList(); };
    });
  }
  renderList();

  // estado dos sell files carregados
  const state = { files:null };

  q('#_probe_load', UI).onclick = async ()=>{
    const superUrl = q('#_probe_su', UI).value.trim();
    const endUrl   = q('#_probe_en', UI).value.trim();
    const midUrl   = q('#_probe_mi', UI).value.trim();
    logEl.textContent = 'Baixando e lendo sell files...\n';
    try {
      state.files = await loadSellFiles({superUrl, endUrl, midUrl});
      const kSuper = (state.files.super||[]).length;
      const kEnd   = (state.files.end||[]).length;
      const kMid   = (state.files.mid||[]).length;
      const kSuperKeep = (state.files.super||[]).filter(r=>r.Keep).length;
      const kEndKeep   = (state.files.end||[]).filter(r=>r.Keep).length;
      const kMidKeep   = (state.files.mid||[]).filter(r=>r.Keep).length;
      logEl.textContent += `Regras carregadas:\n  S+: ${kSuper} (Keep ${kSuperKeep})\n  S : ${kEnd} (Keep ${kEndKeep})\n  Mid: ${kMid} (Keep ${kMidKeep})\n\nSelecione um set e clique em Scan.\n`;
    } catch(e){
      logEl.textContent += 'Erro: ' + (e?.message||e) + '\n';
      console.error(e);
    }
  };

  function doScan(which){
    if (!state.files) { logEl.textContent += 'Carregue os sell files primeiro.\n'; return; }
    if (!sets.length) { logEl.textContent += 'Nenhum set encontrado.\n'; return; }
    const setName = sets[idx].name;
    const rules = which==='su' ? state.files.super : which==='en' ? state.files.end : state.files.mid;
    const res = scanSet(setName, rules||[]);
    const b = res.bySlotKeep;
    logEl.textContent += [
      `\n${setName} - ${res.total} artefatos`,
      `scan [${which==='su'?'S-endgame':which==='en'?'endgame':'midgame'}]`,
      `results: sell ${res.sell} | keep ${res.keep}`,
      `==== keeping ====`,
      `weapon [${b.Weapon}] helmet [${b.Helm}] shield [${b.Shield}]`,
      `gloves [${b.Gloves}] chest [${b.Chest}] boots [${b.Boots}]`,
      ``,
    ].join('\n');
  }
  q('#_probe_scan_su', UI).onclick = ()=>doScan('su');
  q('#_probe_scan_en', UI).onclick = ()=>doScan('en');
  q('#_probe_scan_mi', UI).onclick = ()=>doScan('mi');
  q('#_probe_skip', UI).onclick = ()=>{ idx = Math.min(idx+1, sets.length-1); renderList(); logEl.textContent += '\n(skip) Próximo set selecionado.\n'; };
  q('#_probe_next', UI).onclick = ()=>{ idx = Math.min(idx+1, sets.length-1); renderList(); };

})();
