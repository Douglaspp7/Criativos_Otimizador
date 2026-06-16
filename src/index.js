// ============================================================
// META ADS ANALYST — painel de métricas do negócio no Meta Ads
// Cron: coleta insights (conta + campanhas + anúncios) -> Gemini analisa
//       -> salva snapshot no D1. Dashboard mostra visão geral,
//       drill-down por campanha e o veredito dos criativos.
// Secrets necessários (Settings > Variables do Worker):
//   META_TOKEN        token de acesso (System User, ads_read)
//   META_AD_ACCOUNT   id da conta no formato act_1234567890
//   GEMINI_API_KEY    chave da API do Gemini
//   DASH_KEY          senha do dashboard (você inventa uma)
// ============================================================

const META_API = "https://graph.facebook.com/v21.0";
const PERIODO = "maximum"; // janela das métricas (date_preset da Meta)
const MAX_IMAGENS = 6;     // máx. de imagens enviadas à IA por análise
const MAX_CAMPANHAS = 15;  // máx. de campanhas mandadas à IA / mostradas

// Senha do dashboard. Troque o valor abaixo pela sua senha — é só isso.
// (Se você preferir, pode definir um secret DASH_KEY no Cloudflare; quando
//  ele existe, tem prioridade sobre esta. Mas não é obrigatório.)
const DASH_KEY = "Duda1982**";

// Tipos de ação que contam como conversão (compra ou lead)
const CONV_TYPES = [
  "purchase",
  "omni_purchase",
  "offsite_conversion.fb_pixel_purchase",
  "onsite_web_purchase",
  "lead",
  "onsite_conversion.lead_grouped",
];
// Tipos de ação que carregam valor de receita (só compra)
const VALUE_TYPES = [
  "purchase",
  "omni_purchase",
  "offsite_conversion.fb_pixel_purchase",
  "onsite_web_purchase",
];
// Initiate Checkout — evento-ponte para ler intenção quando há poucas compras
const IC_TYPES = [
  "initiate_checkout",
  "omni_initiated_checkout",
  "offsite_conversion.fb_pixel_initiate_checkout",
  "onsite_web_initiate_checkout",
];
const DIAS_TENDENCIA = 30; // dias na série de tendência diária (time_increment=1)

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAnalysis(env).catch((e) => console.error("Cron:", e.message)));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response(HTML, { headers: { "content-type": "text/html;charset=utf-8" } });
    }

    if (url.pathname.startsWith("/api/")) {
      const expected = env.DASH_KEY || DASH_KEY;
      const key = url.searchParams.get("key") || request.headers.get("x-dash-key");
      if (!expected || key !== expected) {
        return json({ error: "Chave de acesso inválida." }, 401);
      }
      await ensureSchema(env);

      try {
        if (url.pathname === "/api/latest") {
          const row = await env.DB.prepare("SELECT * FROM runs ORDER BY id DESC LIMIT 1").first();
          if (!row) return json(null);
          return json({
            created_at: row.created_at,
            account: safeParse(row.account_json),
            campaigns: safeParse(row.campaigns_json) || [],
            daily: safeParse(row.daily_json) || [],
            ads: JSON.parse(row.metrics_json),
            analysis: safeParse(row.analysis_json),
          });
        }

        if (url.pathname === "/api/history") {
          const rs = await env.DB
            .prepare("SELECT created_at, account_json FROM runs ORDER BY id DESC LIMIT 30")
            .all();
          const runs = (rs.results || []).reverse().map((r) => {
            const acc = safeParse(r.account_json) || {};
            return {
              created_at: r.created_at,
              spend: acc.spend ?? null,
              cpa: acc.cpa ?? null,
              roas: acc.roas ?? null,
              conversions: acc.conversions ?? null,
            };
          });
          return json(runs);
        }

        if (url.pathname === "/api/run" && request.method === "POST") {
          const result = await runAnalysis(env);
          return json(result);
        }

        return json({ error: "Rota não encontrada." }, 404);
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    return new Response("Not found", { status: 404 });
  },
};

// ---------------- Núcleo da análise ----------------

async function runAnalysis(env) {
  await ensureSchema(env);

  const [account, campaigns, ads] = await Promise.all([
    fetchAccountInsights(env),
    fetchCampaignInsights(env),
    fetchAds(env),
  ]);

  if (!ads.length && !campaigns.length) {
    return { ok: false, error: "Nenhum dado com métricas no período (" + PERIODO + ")." };
  }

  rankAds(ads);
  campaigns.sort((a, b) => b.spend - a.spend);

  let daily = [];
  try {
    daily = await fetchDailySeries(env);
  } catch (e) {
    console.error("Tendência diária:", e.message);
  }

  let analysis = null;
  try {
    analysis = await analyzeWithGemini(env, account, campaigns, ads);
  } catch (e) {
    analysis = { erro: "Falha na análise de IA: " + e.message };
  }

  await env.DB
    .prepare(
      "INSERT INTO runs (created_at, account_json, campaigns_json, daily_json, metrics_json, analysis_json) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .bind(
      new Date().toISOString(),
      JSON.stringify(account),
      JSON.stringify(campaigns),
      JSON.stringify(daily),
      JSON.stringify(ads),
      JSON.stringify(analysis)
    )
    .run();

  return {
    ok: true,
    campanhas: campaigns.length,
    anuncios: ads.length,
    gasto: account?.spend ?? null,
    vencedor: ads[0]?.name || null,
  };
}

// Insights agregados da conta inteira no período
async function fetchAccountInsights(env) {
  const fields =
    "spend,impressions,clicks,ctr,cpc,cpm,frequency,actions,action_values,purchase_roas";
  const url =
    META_API + "/" + env.META_AD_ACCOUNT + "/insights" +
    "?level=account&date_preset=" + PERIODO +
    "&fields=" + encodeURIComponent(fields) +
    "&access_token=" + env.META_TOKEN;

  const res = await fetch(url);
  const data = await res.json();
  if (data.error) throw new Error("Meta API (conta): " + data.error.message);

  const row = data.data && data.data[0];
  if (!row) return null;
  return Object.assign({ name: "Conta inteira" }, computeFromInsight(row));
}

// Série diária da conta (uma linha por dia) para a tendência real
async function fetchDailySeries(env) {
  const fields = "spend,actions,action_values,purchase_roas";
  const url =
    META_API + "/" + env.META_AD_ACCOUNT + "/insights" +
    "?level=account&time_increment=1&date_preset=last_" + DIAS_TENDENCIA + "d" +
    "&fields=" + encodeURIComponent(fields) +
    "&limit=" + (DIAS_TENDENCIA + 2) + "&access_token=" + env.META_TOKEN;

  const res = await fetch(url);
  const data = await res.json();
  if (data.error) throw new Error("Meta API (tendência): " + data.error.message);

  return (data.data || []).map((d) => {
    const m = computeFromInsight(d);
    return {
      date: d.date_start,
      spend: m.spend,
      conversions: m.conversions,
      checkouts: m.checkouts,
      revenue: m.revenue,
      cpa: m.cpa,
      roas: m.roas,
    };
  });
}

// Insights por campanha (uma linha por campanha)
async function fetchCampaignInsights(env) {
  const fields =
    "campaign_id,campaign_name,spend,impressions,clicks,ctr,cpc,cpm,frequency,actions,action_values,purchase_roas";
  const url =
    META_API + "/" + env.META_AD_ACCOUNT + "/insights" +
    "?level=campaign&date_preset=" + PERIODO +
    "&fields=" + encodeURIComponent(fields) +
    "&limit=200&access_token=" + env.META_TOKEN;

  const res = await fetch(url);
  const data = await res.json();
  if (data.error) throw new Error("Meta API (campanhas): " + data.error.message);

  return (data.data || [])
    .filter((c) => num(c.spend) > 0)
    .map((c) =>
      Object.assign(
        { id: c.campaign_id, name: c.campaign_name || "(sem nome)" },
        computeFromInsight(c)
      )
    );
}

// Busca anúncios ativos com insights + criativo na Meta Marketing API
async function fetchAds(env) {
  const fields =
    "name,effective_status," +
    "creative{image_url,thumbnail_url,body,title}," +
    "insights.date_preset(" + PERIODO + "){spend,impressions,clicks,ctr,cpc,cpm,frequency,actions,action_values,purchase_roas}";
  const filtering = JSON.stringify([
    { field: "effective_status", operator: "IN", value: ["ACTIVE"] },
  ]);

  const url =
    META_API + "/" + env.META_AD_ACCOUNT + "/ads" +
    "?fields=" + encodeURIComponent(fields) +
    "&filtering=" + encodeURIComponent(filtering) +
    "&limit=50&access_token=" + env.META_TOKEN;

  const res = await fetch(url);
  const data = await res.json();
  if (data.error) throw new Error("Meta API (anúncios): " + data.error.message);

  return (data.data || [])
    .filter((a) => a.insights && a.insights.data && a.insights.data[0])
    .map((a) => {
      const m = computeFromInsight(a.insights.data[0]);
      return Object.assign(
        {
          id: a.id,
          name: a.name,
          image: (a.creative && (a.creative.image_url || a.creative.thumbnail_url)) || null,
          title: (a.creative && a.creative.title) || "",
          copy: (a.creative && a.creative.body) || "",
        },
        m
      );
    });
}

// Extrai o bloco de métricas comum a conta/campanha/anúncio
function computeFromInsight(i) {
  const spend = num(i.spend);
  const conversions = pickAction(i.actions, CONV_TYPES);
  const checkouts = pickAction(i.actions, IC_TYPES);
  const revenue = pickActionValue(i.action_values, VALUE_TYPES);
  // ROAS: prioriza receita/gasto; se a receita não chegar (CAPI sem valor de
  // compra), cai no purchase_roas que a própria Meta devolve, quando houver.
  const metaRoas = i.purchase_roas && i.purchase_roas[0] ? Number(i.purchase_roas[0].value) || 0 : 0;
  let roas = spend > 0 && revenue > 0 ? round2(revenue / spend) : null;
  if (roas === null && metaRoas > 0) roas = round2(metaRoas);
  return {
    spend,
    impressions: num(i.impressions),
    clicks: num(i.clicks),
    ctr: num(i.ctr),
    cpc: num(i.cpc),
    cpm: num(i.cpm),
    frequency: num(i.frequency),
    conversions,
    checkouts,
    revenue: round2(revenue),
    cpa: conversions > 0 ? round2(spend / conversions) : null,
    roas,
  };
}

// Ranking determinístico: menor CPA primeiro; sem conversões, maior CTR
function rankAds(ads) {
  ads.sort((a, b) => {
    if (a.cpa !== null && b.cpa !== null) return a.cpa - b.cpa;
    if (a.cpa !== null) return -1;
    if (b.cpa !== null) return 1;
    return b.ctr - a.ctr;
  });
  ads.forEach((a, idx) => (a.rank = idx + 1));
}

// Envia conta + campanhas + criativos ao Gemini e pede um relatório em JSON
async function analyzeWithGemini(env, account, campaigns, ads) {
  const contaResumo = account
    ? {
        gasto: account.spend,
        impressoes: account.impressions,
        ctr_pct: account.ctr,
        cpm: account.cpm,
        frequencia: account.frequency,
        checkouts: account.checkouts,
        conversoes: account.conversions,
        receita: account.revenue,
        cpa: account.cpa,
        roas: account.roas,
      }
    : null;

  const campanhasTabela = campaigns.slice(0, MAX_CAMPANHAS).map((c) => ({
    campaign_id: c.id,
    nome: c.name,
    gasto: c.spend,
    ctr_pct: c.ctr,
    cpm: c.cpm,
    frequencia: c.frequency,
    checkouts: c.checkouts,
    conversoes: c.conversions,
    receita: c.revenue,
    cpa: c.cpa,
    roas: c.roas,
  }));

  const adsTabela = ads.map((a) => ({
    ad_id: a.id,
    nome: a.name,
    rank: a.rank,
    titulo: a.title,
    copy: a.copy ? a.copy.slice(0, 400) : "",
    gasto: a.spend,
    ctr_pct: a.ctr,
    cpc: a.cpc,
    cpm: a.cpm,
    frequencia: a.frequency,
    checkouts: a.checkouts,
    conversoes: a.conversions,
    cpa: a.cpa,
    roas: a.roas,
  }));

  const systemInstruction =
    "Você é um analista sênior de mídia paga e direct response especializado em infoprodutos " +
    "low-ticket na LATAM, com tráfego frio e mobile-first, sob a lógica do retrieval da Meta (Andromeda): " +
    "o criativo prevê o público, o targeting é sugestão. Analise a conta como um negócio, não só anúncios. " +
    "Diagnostique a saúde da conta, depois cada campanha relevante (eficiência de gasto, CPA, ROAS, fadiga " +
    "quando frequência > 2,5), e os criativos (o que no visual/título/copy explica o desempenho). " +
    "Em conta low-ticket com poucas compras, use 'checkouts' (Initiate Checkout) como evento-ponte para ler intenção. " +
    "Se houver compras mas receita/ROAS vierem zerados, sinalize explicitamente que o CAPI provavelmente não está enviando o valor da compra. " +
    "Por fim, gere uma lista CURTA de sugestões priorizadas e acionáveis para a conta — o que fazer primeiro.\n\n" +
    "Responda SOMENTE com JSON válido, sem markdown, neste formato:\n" +
    '{ "resumo": "visão geral do negócio em 2-3 frases", ' +
    '"saude_conta": "diagnóstico da conta como um todo", ' +
    '"sugestoes_prioritarias": ["ação 1", "ação 2", "ação 3"], ' +
    '"campanhas": [ { "campaign_id": "...", "diagnostico": "...", "melhorias": ["..."] } ], ' +
    '"vencedor": { "ad_id": "...", "pontos_fortes": ["..."], "melhorias": ["..."] }, ' +
    '"criativos": [ { "ad_id": "...", "diagnostico": "...", "melhorias": ["..."] } ] }';

  const parts = [
    {
      text:
        "Dados da conta no período (" + PERIODO + "). Anúncios já ranqueados (rank 1 = melhor, por menor CPA " +
        "ou maior CTR). As imagens dos criativos vêm logo abaixo, na ordem do ranking.\n\n" +
        "CONTA:\n" + JSON.stringify(contaResumo, null, 2) +
        "\n\nCAMPANHAS:\n" + JSON.stringify(campanhasTabela, null, 2) +
        "\n\nANÚNCIOS:\n" + JSON.stringify(adsTabela, null, 2),
    },
  ];

  for (const a of ads.slice(0, MAX_IMAGENS)) {
    if (!a.image) continue;
    try {
      const imgRes = await fetch(a.image);
      const arrBuf = await imgRes.arrayBuffer();

      let binary = "";
      const bytes = new Uint8Array(arrBuf);
      const len = bytes.byteLength;
      for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const base64 = btoa(binary);

      parts.push({ text: "Imagem do criativo rank " + a.rank + " — " + a.name + " (ad_id " + a.id + "):" });
      parts.push({ inline_data: { mime_type: "image/jpeg", data: base64 } });
    } catch (e) {
      console.error("Erro ao baixar imagem do ad " + a.id + ": ", e);
    }
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts }],
        system_instruction: { parts: [{ text: systemInstruction }] },
        generationConfig: { responseMimeType: "application/json" },
      }),
    }
  );

  const data = await res.json();
  if (data.error) throw new Error("Gemini API: " + data.error.message);

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
  const clean = text.replace(/```json|```/g, "").trim();

  try {
    return JSON.parse(clean);
  } catch {
    return { resumo: clean }; // fallback: guarda o texto bruto
  }
}

// ---------------- Utilitários ----------------

async function ensureSchema(env) {
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS runs (" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
      "created_at TEXT NOT NULL, " +
      "account_json TEXT, " +
      "campaigns_json TEXT, " +
      "daily_json TEXT, " +
      "metrics_json TEXT NOT NULL, " +
      "analysis_json TEXT)"
  ).run();

  // Migração suave: adiciona colunas novas em bancos antigos (ignora se já existem)
  for (const col of ["account_json", "campaigns_json", "daily_json"]) {
    try {
      await env.DB.prepare("ALTER TABLE runs ADD COLUMN " + col + " TEXT").run();
    } catch (e) {
      /* coluna já existe */
    }
  }
}

function pickAction(actions, types) {
  if (!actions) return 0;
  for (const t of types) {
    const f = actions.find((x) => x.action_type === t);
    if (f) return Number(f.value) || 0;
  }
  return 0;
}

function pickActionValue(values, types) {
  if (!values) return 0;
  for (const t of types) {
    const f = values.find((x) => x.action_type === t);
    if (f) return Number(f.value) || 0;
  }
  return 0;
}

function num(v) { return Number(v) || 0; }
function round2(v) { return Math.round(v * 100) / 100; }
function safeParse(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }
function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "content-type": "application/json;charset=utf-8" },
  });
}

// ---------------- Dashboard (HTML) ----------------

const HTML = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Meta Ads Analyst</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;600&family=Archivo+Black&family=Spline+Sans+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>
  :root{
    --bg:#ECEDEA; --card:#FFFFFF; --ink:#17191C; --muted:#6B7280;
    --line:#D8DAD4; --blue:#1D4ED8; --gold:#9A6700; --bad:#B42318; --good:#067647;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--ink);font-family:'Archivo',sans-serif;font-size:15px;line-height:1.5;padding:16px;max-width:760px;margin:0 auto}
  h1{font-family:'Archivo Black',sans-serif;font-size:24px;letter-spacing:-0.5px;text-transform:uppercase}
  header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:6px}
  .sub{color:var(--muted);font-size:13px;margin-bottom:14px}
  button{font-family:'Archivo',sans-serif;font-weight:600;font-size:14px;border:1.5px solid var(--ink);background:var(--ink);color:#fff;border-radius:8px;padding:10px 14px;cursor:pointer}
  button:disabled{opacity:.5}
  button:focus-visible{outline:3px solid var(--blue);outline-offset:2px}
  .tabs{display:flex;gap:6px;margin-bottom:16px;border-bottom:1.5px solid var(--line)}
  .tab{background:none;border:none;color:var(--muted);font-weight:600;font-size:14px;padding:10px 4px;margin-right:14px;cursor:pointer;border-bottom:3px solid transparent;border-radius:0}
  .tab.active{color:var(--ink);border-bottom-color:var(--ink)}
  .card{background:var(--card);border:1.5px solid var(--line);border-radius:14px;padding:16px;margin-bottom:14px;position:relative}
  .champ{border:2px solid var(--ink);box-shadow:5px 5px 0 var(--ink)}
  .stamp{position:absolute;top:-12px;right:12px;transform:rotate(-6deg);font-family:'Archivo Black',sans-serif;font-size:13px;letter-spacing:1.5px;color:var(--gold);border:2.5px solid var(--gold);border-radius:6px;padding:3px 10px;background:var(--card);text-transform:uppercase}
  .adname{font-weight:600;font-size:16px;margin-bottom:2px;padding-right:90px}
  .rank{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px}
  img.creative{width:100%;border-radius:10px;border:1px solid var(--line);margin-bottom:12px;display:block}
  .metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px}
  .m{background:var(--bg);border-radius:8px;padding:8px}
  .m .v{font-family:'Spline Sans Mono',monospace;font-weight:600;font-size:15px}
  .m .l{font-size:10px;text-transform:uppercase;letter-spacing:.8px;color:var(--muted)}
  .kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px}
  .kpi{background:var(--card);border:1.5px solid var(--line);border-radius:12px;padding:12px}
  .kpi .v{font-family:'Spline Sans Mono',monospace;font-weight:600;font-size:20px}
  .kpi .l{font-size:10px;text-transform:uppercase;letter-spacing:.8px;color:var(--muted);margin-top:2px}
  .sec{font-family:'Archivo Black',sans-serif;font-size:12px;text-transform:uppercase;letter-spacing:1.2px;margin:12px 0 6px}
  .sec.gold{color:var(--gold)} .sec.blue{color:var(--blue)}
  ul{padding-left:18px}
  li{margin-bottom:5px}
  .diag{color:var(--ink)}
  .resumo{background:var(--ink);color:#F4F4F2;border-radius:14px;padding:16px;margin-bottom:14px;font-size:14px}
  .resumo .sec{color:#FBBF24;margin-top:0}
  .resumo .sec.next{color:#7DD3FC;margin-top:14px}
  .trend{background:var(--card);border:1.5px solid var(--line);border-radius:12px;padding:14px;margin-bottom:16px}
  .trend svg{display:block;width:100%;height:48px;margin-top:8px}
  .trend polyline{fill:none;stroke:var(--blue);stroke-width:2}
  .empty{text-align:center;color:var(--muted);padding:50px 20px}
  .err{color:var(--bad);font-weight:600}
  #keybox{display:flex;gap:8px;margin:30px 0}
  #keybox input{flex:1;border:1.5px solid var(--line);border-radius:8px;padding:10px;font-size:15px;font-family:'Spline Sans Mono',monospace}
  .ts{font-size:12px;color:var(--muted)}
  @media (prefers-reduced-motion: no-preference){
    .card,.kpi{animation:up .3s ease both}
    @keyframes up{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
  }
</style>
</head>
<body>
<header>
  <h1>Meta Ads Analyst</h1>
  <button id="runbtn" style="display:none">Rodar análise</button>
</header>
<p class="sub">Painel da sua conta no Meta Ads · período: histórico <span class="ts" id="ts"></span></p>

<div id="keybox">
  <input id="keyinput" type="password" placeholder="Chave de acesso (DASH_KEY)">
  <button id="keybtn">Entrar</button>
</div>

<div id="tabs" class="tabs" style="display:none">
  <button class="tab active" data-tab="overview">Visão geral</button>
  <button class="tab" data-tab="campaigns">Campanhas</button>
  <button class="tab" data-tab="creatives">Criativos</button>
</div>

<div id="app"></div>

<script>
(function(){
  var KEY = localStorage.getItem("dashkey") || "";
  var TAB = "overview";
  var DATA = null, HISTORY = [];
  var app = document.getElementById("app");
  var keybox = document.getElementById("keybox");
  var tabs = document.getElementById("tabs");
  var runbtn = document.getElementById("runbtn");

  document.getElementById("keybtn").onclick = function(){
    KEY = document.getElementById("keyinput").value.trim();
    localStorage.setItem("dashkey", KEY);
    load();
  };
  runbtn.onclick = function(){
    runbtn.disabled = true; runbtn.textContent = "Analisando...";
    fetch("/api/run?key=" + encodeURIComponent(KEY), { method: "POST" })
      .then(function(r){ return r.json(); })
      .then(function(res){
        if (res.error) alert(res.error);
        runbtn.disabled = false; runbtn.textContent = "Rodar análise";
        load();
      })
      .catch(function(){ runbtn.disabled = false; runbtn.textContent = "Rodar análise"; });
  };
  Array.prototype.forEach.call(tabs.querySelectorAll(".tab"), function(t){
    t.onclick = function(){
      TAB = t.getAttribute("data-tab");
      Array.prototype.forEach.call(tabs.querySelectorAll(".tab"), function(x){ x.classList.remove("active"); });
      t.classList.add("active");
      render();
    };
  });

  function fmt(v, money){
    if (v === null || v === undefined) return "—";
    var n = Number(v);
    return money ? "$ " + n.toFixed(2) : (Math.round(n * 100) / 100).toString();
  }
  function esc(s){
    return String(s || "").replace(/[&<>"]/g, function(c){
      return { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c];
    });
  }
  function metricCell(label, value){
    return '<div class="m"><div class="v">' + value + '</div><div class="l">' + label + '</div></div>';
  }
  function kpiCell(label, value){
    return '<div class="kpi"><div class="v">' + value + '</div><div class="l">' + label + '</div></div>';
  }
  function listHtml(items){
    if (!items || !items.length) return "";
    var out = "<ul>";
    for (var i = 0; i < items.length; i++) out += "<li>" + esc(items[i]) + "</li>";
    return out + "</ul>";
  }
  function metricsGrid(a){
    return '<div class="metrics">'
      + metricCell("Gasto", fmt(a.spend, true))
      + metricCell("CTR %", fmt(a.ctr))
      + metricCell("Freq.", fmt(a.frequency))
      + metricCell("Checkouts", fmt(a.checkouts))
      + metricCell(a.conversions > 0 ? "CPA" : "Conv.", a.conversions > 0 ? fmt(a.cpa, true) : "0")
      + metricCell("ROAS", a.roas ? fmt(a.roas) + "x" : "—")
      + '</div>';
  }
  function sparkline(values){
    var clean = values.filter(function(v){ return v !== null && v !== undefined; });
    if (clean.length < 2) return "";
    var max = Math.max.apply(null, clean), min = Math.min.apply(null, clean);
    var range = (max - min) || 1, W = 320, H = 48;
    var pts = clean.map(function(v, i){
      var x = (i / (clean.length - 1)) * W;
      var y = H - ((v - min) / range) * H;
      return x.toFixed(1) + "," + y.toFixed(1);
    }).join(" ");
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none"><polyline points="' + pts + '"/></svg>';
  }

  function renderOverview(){
    var acc = DATA.account || {};
    var an = DATA.analysis || {};
    var html = "";

    html += '<div class="kpis">'
      + kpiCell("Gasto", fmt(acc.spend, true))
      + kpiCell("Conversões", fmt(acc.conversions))
      + kpiCell("Checkouts", fmt(acc.checkouts))
      + kpiCell("CPA", acc.conversions > 0 ? fmt(acc.cpa, true) : "—")
      + kpiCell("ROAS", acc.roas ? fmt(acc.roas) + "x" : "—")
      + kpiCell("CTR %", fmt(acc.ctr))
      + kpiCell("CPM", fmt(acc.cpm, true))
      + '</div>';

    var daily = DATA.daily || [];
    var spendSeries = daily.length ? daily.map(function(d){ return d.spend; }) : HISTORY.map(function(h){ return h.spend; });
    var trendLabel = daily.length ? ("Gasto diário · últimos " + daily.length + " dias") : "Gasto ao longo dos snapshots";
    var spark = sparkline(spendSeries);
    if (spark) {
      html += '<div class="trend"><div class="sec">' + trendLabel + '</div>' + spark + '</div>';
    }

    if (an.resumo || an.saude_conta || (an.sugestoes_prioritarias && an.sugestoes_prioritarias.length)) {
      html += '<div class="resumo">';
      if (an.resumo) html += '<div class="sec">Resumo do negócio</div>' + esc(an.resumo);
      if (an.saude_conta) html += '<div class="sec next">Saúde da conta</div>' + esc(an.saude_conta);
      if (an.sugestoes_prioritarias && an.sugestoes_prioritarias.length) {
        html += '<div class="sec next">O que fazer primeiro</div>' + listHtml(an.sugestoes_prioritarias);
      }
      html += '</div>';
    }
    if (an.erro) html += '<div class="resumo"><span class="err">' + esc(an.erro) + '</span></div>';

    if (!html) html = '<div class="empty">Sem dados ainda. Toque em <b>Rodar análise</b>.</div>';
    app.innerHTML = html;
  }

  function renderCampaigns(){
    var an = DATA.analysis || {};
    var byId = {};
    var diag = an.campanhas || [];
    for (var i = 0; i < diag.length; i++) byId[diag[i].campaign_id] = diag[i];

    var camps = DATA.campaigns || [];
    if (!camps.length) {
      app.innerHTML = '<div class="empty">Nenhuma campanha com gasto no período.</div>';
      return;
    }
    var html = "";
    for (var j = 0; j < camps.length; j++) {
      var c = camps[j];
      html += '<div class="card">';
      html += '<div class="adname">' + esc(c.name) + '</div>';
      html += '<div class="rank">Campanha · receita ' + fmt(c.revenue, true) + '</div>';
      html += metricsGrid(c);
      if (byId[c.id]) {
        html += '<div class="sec">Diagnóstico</div><p class="diag">' + esc(byId[c.id].diagnostico) + '</p>';
        html += '<div class="sec blue">Melhorias propostas</div>' + listHtml(byId[c.id].melhorias);
      }
      html += '</div>';
    }
    app.innerHTML = html;
  }

  function renderCreatives(){
    var an = DATA.analysis || {};
    var byId = {};
    var crts = an.criativos || [];
    for (var i = 0; i < crts.length; i++) byId[crts[i].ad_id] = crts[i];

    var ads = DATA.ads || [];
    if (!ads.length) {
      app.innerHTML = '<div class="empty">Nenhum anúncio ativo com métricas.</div>';
      return;
    }
    var html = "";
    for (var j = 0; j < ads.length; j++) {
      var a = ads[j];
      var isChamp = a.rank === 1;
      html += '<div class="card' + (isChamp ? " champ" : "") + '">';
      if (isChamp) html += '<div class="stamp">Campeão</div>';
      html += '<div class="adname">' + esc(a.name) + '</div>';
      html += '<div class="rank">Rank ' + a.rank + " de " + ads.length + '</div>';
      if (a.image) html += '<img class="creative" src="' + esc(a.image) + '" alt="Criativo ' + esc(a.name) + '">';
      html += metricsGrid(a);
      if (isChamp && an.vencedor) {
        html += '<div class="sec gold">Pontos fortes</div>' + listHtml(an.vencedor.pontos_fortes);
        html += '<div class="sec blue">Para melhorar ainda mais</div>' + listHtml(an.vencedor.melhorias);
      } else if (byId[a.id]) {
        html += '<div class="sec">Diagnóstico</div><p class="diag">' + esc(byId[a.id].diagnostico) + '</p>';
        html += '<div class="sec blue">Melhorias propostas</div>' + listHtml(byId[a.id].melhorias);
      }
      html += '</div>';
    }
    app.innerHTML = html;
  }

  function render(){
    if (!DATA) {
      app.innerHTML = '<div class="empty">Nenhuma análise ainda. Toque em <b>Rodar análise</b> para gerar a primeira.</div>';
      return;
    }
    document.getElementById("ts").textContent = "· atualizado " + new Date(DATA.created_at).toLocaleString("pt-BR");
    if (TAB === "campaigns") renderCampaigns();
    else if (TAB === "creatives") renderCreatives();
    else renderOverview();
  }

  function load(){
    if (!KEY) return;
    Promise.all([
      fetch("/api/latest?key=" + encodeURIComponent(KEY)).then(function(r){
        if (r.status === 401) { localStorage.removeItem("dashkey"); KEY = ""; keybox.style.display = "flex"; tabs.style.display = "none"; runbtn.style.display = "none"; throw new Error("auth"); }
        return r.json();
      }),
      fetch("/api/history?key=" + encodeURIComponent(KEY)).then(function(r){ return r.json(); }).catch(function(){ return []; }),
    ]).then(function(arr){
      DATA = arr[0];
      HISTORY = arr[1] || [];
      keybox.style.display = "none";
      tabs.style.display = DATA ? "flex" : "none";
      runbtn.style.display = "inline-block";
      render();
    }).catch(function(){});
  }

  if (KEY) { keybox.style.display = "none"; load(); }
})();
</script>
</body>
</html>`;
