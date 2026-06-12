// ============================================================
// CRIATIVO JUDGE — avaliador de criativos do Meta Ads
// Cron: busca métricas + criativos -> Claude analisa -> salva no D1
// Dashboard: ranking, campeão, pontos fortes e melhorias
// Secrets necessários (Settings > Variables do Worker):
//   META_TOKEN        token de acesso (System User, ads_read)
//   META_AD_ACCOUNT   id da conta no formato act_1234567890
//   ANTHROPIC_API_KEY chave da API da Anthropic
//   DASH_KEY          senha do dashboard (você inventa uma)
// ============================================================

const META_API = "https://graph.facebook.com/v21.0";
const PERIODO = "last_7d"; // janela das métricas
const MAX_IMAGENS = 6;     // máx. de imagens enviadas à IA por análise

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
      const key = url.searchParams.get("key") || request.headers.get("x-dash-key");
      if (!env.DASH_KEY || key !== env.DASH_KEY) {
        return json({ error: "Chave de acesso inválida." }, 401);
      }
      await ensureSchema(env);

      try {
        if (url.pathname === "/api/latest") {
          const row = await env.DB.prepare("SELECT * FROM runs ORDER BY id DESC LIMIT 1").first();
          if (!row) return json(null);
          return json({
            created_at: row.created_at,
            ads: JSON.parse(row.metrics_json),
            analysis: safeParse(row.analysis_json),
          });
        }

        if (url.pathname === "/api/history") {
          const rs = await env.DB
            .prepare("SELECT created_at, metrics_json FROM runs ORDER BY id DESC LIMIT 14")
            .all();
          const runs = (rs.results || []).reverse().map((r) => ({
            created_at: r.created_at,
            ads: JSON.parse(r.metrics_json).map((a) => ({ id: a.id, name: a.name, ctr: a.ctr, cpa: a.cpa })),
          }));
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

  const ads = await fetchAds(env);
  if (!ads.length) {
    return { ok: false, error: "Nenhum anúncio ativo com métricas no período (" + PERIODO + ")." };
  }

  rankAds(ads);

  let analysis = null;
  try {
    analysis = await analyzeWithClaude(env, ads);
  } catch (e) {
    analysis = { erro: "Falha na análise de IA: " + e.message };
  }

  await env.DB
    .prepare("INSERT INTO runs (created_at, metrics_json, analysis_json) VALUES (?, ?, ?)")
    .bind(new Date().toISOString(), JSON.stringify(ads), JSON.stringify(analysis))
    .run();

  return { ok: true, ads: ads.length, vencedor: ads[0]?.name || null };
}

// Busca anúncios ativos com insights + criativo na Meta Marketing API
async function fetchAds(env) {
  const fields =
    "name,effective_status," +
    "creative{image_url,thumbnail_url,body,title}," +
    "insights.date_preset(" + PERIODO + "){spend,impressions,clicks,ctr,cpc,cpm,frequency,actions}";
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
  if (data.error) throw new Error("Meta API: " + data.error.message);

  return (data.data || [])
    .filter((a) => a.insights && a.insights.data && a.insights.data[0])
    .map((a) => {
      const i = a.insights.data[0];
      const spend = num(i.spend);
      const conversions = pickAction(i.actions, [
        "purchase",
        "omni_purchase",
        "offsite_conversion.fb_pixel_purchase",
        "onsite_web_purchase",
        "lead",
        "onsite_conversion.lead_grouped",
      ]);
      return {
        id: a.id,
        name: a.name,
        image: (a.creative && (a.creative.image_url || a.creative.thumbnail_url)) || null,
        title: (a.creative && a.creative.title) || "",
        copy: (a.creative && a.creative.body) || "",
        spend,
        impressions: num(i.impressions),
        clicks: num(i.clicks),
        ctr: num(i.ctr),
        cpc: num(i.cpc),
        cpm: num(i.cpm),
        frequency: num(i.frequency),
        conversions,
        cpa: conversions > 0 ? round2(spend / conversions) : null,
      };
    });
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

// Envia métricas + imagens dos criativos para o Claude e pede JSON
async function analyzeWithClaude(env, ads) {
  const metricsTable = ads.map((a) => ({
    ad_id: a.id,
    nome: a.name,
    rank: a.rank,
    titulo: a.title,
    copy: a.copy ? a.copy.slice(0, 400) : "",
    gasto: a.spend,
    impressoes: a.impressions,
    ctr_pct: a.ctr,
    cpc: a.cpc,
    cpm: a.cpm,
    frequencia: a.frequency,
    conversoes: a.conversions,
    cpa: a.cpa,
  }));

  const content = [
    {
      type: "text",
      text:
        "Você é um especialista em direct response e Meta Ads para produtos digitais low-ticket na LATAM. " +
        "Abaixo estão as métricas dos últimos 7 dias dos anúncios ativos, já ranqueados (rank 1 = melhor, " +
        "por menor CPA ou maior CTR). Em seguida, as imagens dos criativos na mesma ordem.\n\n" +
        "MÉTRICAS:\n" + JSON.stringify(metricsTable, null, 2) + "\n\n" +
        "Analise o criativo vencedor (rank 1): o que na imagem, no título e na copy explica a performance? " +
        "Depois diagnostique cada um dos demais e proponha melhorias concretas e acionáveis " +
        "(ângulo, hook, elemento visual, prova, CTA). Considere fadiga quando a frequência for alta (>2,5).\n\n" +
        "Responda SOMENTE com JSON válido, sem markdown, neste formato:\n" +
        '{ "resumo": "visão geral em 2-3 frases", ' +
        '"vencedor": { "ad_id": "...", "pontos_fortes": ["..."], "melhorias": ["..."] }, ' +
        '"criativos": [ { "ad_id": "...", "diagnostico": "...", "melhorias": ["..."] } ] }',
    },
  ];

  for (const a of ads.slice(0, MAX_IMAGENS)) {
    if (!a.image) continue;
    content.push({ type: "text", text: "Imagem do criativo rank " + a.rank + " — " + a.name + " (ad_id " + a.id + "):" });
    content.push({ type: "image", source: { type: "url", url: a.image } });
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 3000,
      messages: [{ role: "user", content }],
    }),
  });

  const data = await res.json();
  if (data.error) throw new Error("Anthropic API: " + data.error.message);

  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
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
      "metrics_json TEXT NOT NULL, " +
      "analysis_json TEXT)"
  ).run();
}

function pickAction(actions, types) {
  if (!actions) return 0;
  for (const t of types) {
    const f = actions.find((x) => x.action_type === t);
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
<title>Criativo Judge</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;600&family=Archivo+Black&family=Spline+Sans+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>
  :root{
    --bg:#ECEDEA; --card:#FFFFFF; --ink:#17191C; --muted:#6B7280;
    --line:#D8DAD4; --blue:#1D4ED8; --gold:#9A6700; --bad:#B42318; --good:#067647;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--ink);font-family:'Archivo',sans-serif;font-size:15px;line-height:1.5;padding:16px;max-width:760px;margin:0 auto}
  h1{font-family:'Archivo Black',sans-serif;font-size:26px;letter-spacing:-0.5px;text-transform:uppercase}
  header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:6px}
  .sub{color:var(--muted);font-size:13px;margin-bottom:18px}
  button{font-family:'Archivo',sans-serif;font-weight:600;font-size:14px;border:1.5px solid var(--ink);background:var(--ink);color:#fff;border-radius:8px;padding:10px 14px;cursor:pointer}
  button:disabled{opacity:.5}
  button:focus-visible{outline:3px solid var(--blue);outline-offset:2px}
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
  .sec{font-family:'Archivo Black',sans-serif;font-size:12px;text-transform:uppercase;letter-spacing:1.2px;margin:12px 0 6px}
  .sec.gold{color:var(--gold)} .sec.blue{color:var(--blue)}
  ul{padding-left:18px}
  li{margin-bottom:5px}
  .diag{color:var(--ink)}
  .resumo{background:var(--ink);color:#F4F4F2;border-radius:14px;padding:16px;margin-bottom:18px;font-size:14px}
  .resumo .sec{color:#FBBF24;margin-top:0}
  .empty{text-align:center;color:var(--muted);padding:50px 20px}
  .err{color:var(--bad);font-weight:600}
  #keybox{display:flex;gap:8px;margin:30px 0}
  #keybox input{flex:1;border:1.5px solid var(--line);border-radius:8px;padding:10px;font-size:15px;font-family:'Spline Sans Mono',monospace}
  .ts{font-size:12px;color:var(--muted)}
  @media (prefers-reduced-motion: no-preference){
    .card{animation:up .3s ease both}
    @keyframes up{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
  }
</style>
</head>
<body>
<header>
  <h1>Criativo Judge</h1>
  <button id="runbtn" style="display:none">Rodar análise</button>
</header>
<p class="sub">Veredito dos seus criativos no Meta Ads · últimos 7 dias <span class="ts" id="ts"></span></p>

<div id="keybox">
  <input id="keyinput" type="password" placeholder="Chave de acesso (DASH_KEY)">
  <button id="keybtn">Entrar</button>
</div>

<div id="app"></div>

<script>
(function(){
  var KEY = localStorage.getItem("dashkey") || "";
  var app = document.getElementById("app");
  var keybox = document.getElementById("keybox");
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
      .then(function(){ runbtn.disabled = false; runbtn.textContent = "Rodar análise"; load(); })
      .catch(function(){ runbtn.disabled = false; runbtn.textContent = "Rodar análise"; });
  };

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
  function listHtml(items){
    if (!items || !items.length) return "";
    var out = "<ul>";
    for (var i = 0; i < items.length; i++) out += "<li>" + esc(items[i]) + "</li>";
    return out + "</ul>";
  }

  function render(data){
    if (!data) {
      app.innerHTML = '<div class="empty">Nenhuma análise ainda. Toque em <b>Rodar análise</b> para gerar a primeira.</div>';
      return;
    }
    document.getElementById("ts").textContent = "· atualizado " + new Date(data.created_at).toLocaleString("pt-BR");
    var an = data.analysis || {};
    var byId = {};
    var crts = an.criativos || [];
    for (var i = 0; i < crts.length; i++) byId[crts[i].ad_id] = crts[i];

    var html = "";
    if (an.resumo) html += '<div class="resumo"><div class="sec">Resumo do juiz</div>' + esc(an.resumo) + '</div>';
    if (an.erro) html += '<div class="resumo"><span class="err">' + esc(an.erro) + '</span></div>';

    for (var j = 0; j < data.ads.length; j++) {
      var a = data.ads[j];
      var isChamp = a.rank === 1;
      html += '<div class="card' + (isChamp ? " champ" : "") + '">';
      if (isChamp) html += '<div class="stamp">Campeão</div>';
      html += '<div class="adname">' + esc(a.name) + '</div>';
      html += '<div class="rank">Rank ' + a.rank + " de " + data.ads.length + '</div>';
      if (a.image) html += '<img class="creative" src="' + esc(a.image) + '" alt="Criativo ' + esc(a.name) + '">';
      html += '<div class="metrics">'
        + metricCell("Gasto", fmt(a.spend, true))
        + metricCell("CTR %", fmt(a.ctr))
        + metricCell("CPC", fmt(a.cpc, true))
        + metricCell("CPM", fmt(a.cpm, true))
        + metricCell("Freq.", fmt(a.frequency))
        + metricCell(a.conversions > 0 ? "CPA" : "Conv.", a.conversions > 0 ? fmt(a.cpa, true) : "0")
        + '</div>';

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

  function load(){
    if (!KEY) return;
    fetch("/api/latest?key=" + encodeURIComponent(KEY))
      .then(function(r){
        if (r.status === 401) { localStorage.removeItem("dashkey"); KEY = ""; keybox.style.display = "flex"; runbtn.style.display = "none"; throw new Error("auth"); }
        return r.json();
      })
      .then(function(data){
        keybox.style.display = "none";
        runbtn.style.display = "inline-block";
        render(data);
      })
      .catch(function(){});
  }

  if (KEY) { keybox.style.display = "none"; load(); }
})();
</script>
</body>
</html>`;
