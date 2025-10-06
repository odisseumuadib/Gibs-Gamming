/**
 * Converte URL padrão do GitHub → raw.githubusercontent.com
 */
function toRawGitUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'github.com') {
      // /user/repo/blob/branch/path → raw
      const parts = u.pathname.split('/').filter(Boolean);
      const [user, repo, /*blob*/, branch, ...rest] = parts;
      return `https://raw.githubusercontent.com/${user}/${repo}/${branch}/${rest.join('/')}`;
    }
    return url;
  } catch { return url; }
}

/**
 * Baixa texto (browser ou Node 18+)
 */
async function fetchText(url) {
  const res = await fetch(toRawGitUrl(url));
  if (!res.ok) throw new Error(`Falha ao baixar: ${url} (${res.status})`);
  return res.text();
}

/**
 * Tier normalizado
 */
function normTier(s) {
  const t = String(s || '').trim().toUpperCase();
  if (t === 'SUPER-ENDGAME' || t === 'SUPERENDGAME' || t === 'S+'
   || t === 'SPLUS' || t === 'S_PLUS') return 'SUPER-ENDGAME';
  if (t === 'ENDGAME' || t === 'S') return 'ENDGAME';
  if (t === 'MIDGAME' || t === 'MID') return 'MIDGAME';
  throw new Error(`Tier inválido: "${s}" (use SUPER-ENDGAME | ENDGAME | MIDGAME)`);
}

/**
 * Extrai sufixo de perfil (OFF/DEF/HYB). Sem sufixo ⇒ DEF.
 * Ex.: "StoneSkin_OFF" → { base:"StoneSkin", profile:"OFF" }
 */
function splitNameProfile(rawName) {
  const name = String(rawName).trim();
  const m = name.match(/^(.*?)(?:_(OFF|DEF|HYB))?$/i);
  const base = m?.[1]?.trim() || name;
  const profile = (m?.[2]?.toUpperCase() || 'DEF');
  return { base, profile };
}

/**
 * Parser de uma linha ativa do config.
 * Formato: SET_NAME[ _SUFIXO ] | CODE | TIER | QTD | [TOPROW a-b]
 * Ex.: "Bolster | 51 | SUPER-ENDGAME | 5 | TOPROW 3-7"
 */
function parseConfigLine(line, defaults = { toprowMin: 3, toprowMax: 7 }) {
  // remove comentários finais " # ..."
  const stripped = line.split('#')[0].trim();
  if (!stripped) return null;

  const parts = stripped.split('|').map(s => s.trim()).filter(Boolean);
  if (parts.length < 4) {
    throw new Error(`Linha inválida (esperado 4+ campos): ${line}`);
  }

  const [nameRaw, codeRaw, tierRaw, qtyRaw, extraRaw = ''] = parts;

  const { base: setName, profile } = splitNameProfile(nameRaw);

  const code = isNaN(Number(codeRaw)) ? String(codeRaw).trim() : Number(codeRaw);
  const tier = normTier(tierRaw);

  const target = (String(qtyRaw).toUpperCase() === 'AUTO') ? 'AUTO' : Number(qtyRaw);
  if (target !== 'AUTO' && (!Number.isFinite(target) || target < 0)) {
    throw new Error(`Quantidade inválida em: ${line}`);
  }

  // TOPROW a-b opcional
  let topMin = defaults.toprowMin;
  let topMax = defaults.toprowMax;

  const extra = String(extraRaw || '');
  if (/TOPROW/i.test(extra)) {
    const m = extra.match(/TOPROW\s+(\d+)\s*[-–]\s*(\d+)/i);
    if (!m) throw new Error(`Sintaxe TOPROW inválida: "${extra}" (use "TOPROW 3-7")`);
    topMin = Number(m[1]); topMax = Number(m[2]);
    if (!(topMin >= 0 && topMax >= topMin)) {
      throw new Error(`Faixa TOPROW inválida: ${topMin}-${topMax}`);
    }
  }

  return {
    rawLine: line,
    setDisplay: nameRaw,      // como está no arquivo (p/ logs)
    setName,                  // base (sem sufixo)
    profile,                  // OFF | DEF | HYB (default DEF)
    code,                     // código do set (id/num)
    tierTarget: tier,         // SUPER-ENDGAME | ENDGAME | MIDGAME
    targetSets: target,       // número ou "AUTO"
    toprow: { min: topMin, max: topMax } // janela superior
  };
}

/**
 * Parser do arquivo inteiro .txt
 */
function parseConfigTxt(text, options = {}) {
  const lines = String(text).split(/\r?\n/);
  const defaults = {
    toprowMin: options.toprowMin ?? 3,
    toprowMax: options.toprowMax ?? 7
  };

  const entries = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parsed = parseConfigLine(line, defaults);
    if (parsed) entries.push(parsed);
  }
  return { entries, defaults };
}

/**
 * Parser simples de Sell File (.hsf) — geralmente é JSON puro.
 * Suporta: string → objeto / já-objeto → retorna como está.
 */
function parseSellFile(hsfSource) {
  if (typeof hsfSource === 'string') {
    // Pode ser JSON em string; há versões que vêm minificadas
    try { return JSON.parse(hsfSource); }
    catch (e) {
      // algumas versões têm BOM/ruído; tenta limpar
      const cleaned = hsfSource.replace(/^\uFEFF/, '').trim();
      return JSON.parse(cleaned);
    }
  }
  if (typeof hsfSource === 'object' && hsfSource) return hsfSource;
  throw new Error('Sell file em formato inesperado.');
}
