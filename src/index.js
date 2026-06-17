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
const MAX_LPS = 3;         // máx. de landing pages baixadas e analisadas por run
const LP_CHARS = 3000;     // tamanho do texto da LP enviado à IA (por página)

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
// Modelos do Gemini em ordem de preferência; cai para o próximo se um sumir
const GEMINI_MODELS = ["gemini-2.5-pro", "gemini-2.5-flash"];
// IA preferida: se houver o secret ANTHROPIC_API_KEY, usa o Claude Opus 4.8;
// senão, cai no Gemini. (A API da Anthropic é cobrada à parte da assinatura Claude.ai.)
const CLAUDE_MODEL = "claude-opus-4-8";

// ---- Otimização (Fase 1: sugerir → você aprova no celular → executa) ----
// Métrica-alvo desta conta: CHECKOUTS / CTR (low-ticket, poucas compras).
const METRICA_ALVO = "checkouts_ctr";
const MAX_ACOES = 5;            // máx. de ações que a IA pode propor por execução
const BUDGET_STEP_MIN = 10;     // % mínimo de ajuste de verba por vez
const BUDGET_STEP_MAX = 30;     // % máximo de ajuste de verba por vez (trava de mão)
const BUDGET_PISO_CENTS = 500;  // verba diária mínima após reduzir (em centavos = R$5,00)
const ACOES_VALIDAS = ["pausar", "escalar", "reduzir"]; // whitelist de tipos

// ---- Fase 2: detecção automática de perdedores (ainda requer aprovação) ----
// Regra determinística que propõe PAUSAR anúncios claramente ruins. Nada é
// pausado sozinho — vira ação pendente e você autoriza pelo WhatsApp/painel.
const MIN_IMPRESSOES_REGRA = 1000; // abaixo disso, dados insuficientes: não age
const CTR_FRACO_FRACAO = 0.5;      // CTR < metade do CTR da conta = fraco
const SPEND_FLOOR_MULT = 2;        // gastou ≥ 2x (CPA da conta OU média) sem retorno

// ---- Fase 3: escalar vencedores (também requer aprovação) ----
const FREQ_FADIGA = 2.5;           // acima disso há fadiga: não escala
const ESCALAR_PCT_PADRAO = 20;     // % de aumento de verba proposto ao vencedor
const MAX_ESCALAR_POR_RUN = 1;     // escala no máx. 1 campanha por análise (cautela)

// ---- Notificação por WhatsApp (avisa quando há ação nova pra aprovar) ----
// Usa o CallMeBot (grátis p/ uso pessoal). Número em formato internacional,
// só dígitos (sem +, espaço ou traço). A apikey vem do secret CALLMEBOT_APIKEY.
const WHATSAPP_PHONE = "5513988751089";

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAnalysis(env).catch((e) => console.error("Cron:", e.message)));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response(HTML, { headers: { "content-type": "text/html;charset=utf-8" } });
    }

    // Aprovar/Rejeitar de 1 toque pelo link do WhatsApp (autenticado por token)
    if (url.pathname === "/act") {
      await ensureSchema(env);
      const id = Number(url.searchParams.get("id"));
      const token = url.searchParams.get("t") || "";
      const decision = url.searchParams.get("d") || "";
      if (!id || (decision !== "approve" && decision !== "reject")) {
        return htmlPage("Link inválido", "Parâmetros faltando ou incorretos.", false);
      }
      let res;
      try {
        res = await decideActionByToken(env, id, token, decision);
      } catch (e) {
        res = { ok: false, error: e.message };
      }
      const alvo = res.target_name ? " — " + res.target_name : "";
      if (res.ok && res.status === "approved") {
        return htmlPage("✅ Aprovado", "Ação executada na Meta" + alvo + ".", true);
      }
      if (res.ok && res.status === "rejected") {
        return htmlPage("Rejeitado", "A ação foi descartada" + alvo + ".", true);
      }
      return htmlPage("Não aplicado", res.error || "Não foi possível concluir.", false);
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

        // Lista as ações pendentes de aprovação (mais novas primeiro)
        if (url.pathname === "/api/actions") {
          const rs = await env.DB
            .prepare(
              "SELECT id, created_at, level, target_id, target_name, action_type, percent, reason, metric_json " +
                "FROM actions WHERE status = 'pending' ORDER BY id DESC LIMIT 50"
            )
            .all();
          const acoes = (rs.results || []).map((r) => ({
            id: r.id,
            created_at: r.created_at,
            level: r.level,
            target_id: r.target_id,
            target_name: r.target_name,
            action_type: r.action_type,
            percent: r.percent,
            reason: r.reason,
            metric: safeParse(r.metric_json),
          }));
          return json(acoes);
        }

        // Aprovar (executa na Meta) ou rejeitar uma ação pendente
        if (url.pathname === "/api/actions/decide" && request.method === "POST") {
          const bodyTxt = await request.text();
          const body = safeParse(bodyTxt) || {};
          const id = Number(body.id);
          const decision = String(body.decision || "");
          if (!id || (decision !== "approve" && decision !== "reject")) {
            return json({ error: "Parâmetros inválidos (id, decision)." }, 400);
          }
          const result = await decideAction(env, id, decision);
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

  const m = meta(env);
  if (!m.token) {
    return { ok: false, error: "META_TOKEN ausente ou vazio — cole no secret do Cloudflare um token de System User com ads_read." };
  }
  if (!m.account.startsWith("act_")) {
    return { ok: false, error: "META_AD_ACCOUNT inválido — use o formato act_1234567890 (com o prefixo act_)." };
  }

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
    analysis = await analyze(env, account, campaigns, ads);
  } catch (e) {
    analysis = { erro: "Falha na análise de IA: " + e.message };
  }

  const ins = await env.DB
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

  const runId = ins?.meta?.last_row_id || null;

  // Fase 2: junta as ações da IA com os perdedores detectados pela regra
  // determinística (ambos só viram propostas PENDENTES — você ainda autoriza).
  const acoesIA = (analysis && Array.isArray(analysis.acoes)) ? analysis.acoes : [];
  const acoesRegra = detectLosers(account, ads).concat(detectWinners(account, campaigns));
  const todasAcoes = acoesIA.concat(acoesRegra);

  let enfileiradas = [];
  try {
    enfileiradas = await enqueueActions(env, runId, todasAcoes, campaigns, ads);
  } catch (e) {
    console.error("Fila de ações:", e.message);
  }

  // Avisa no WhatsApp quando há ação nova esperando aprovação.
  if (enfileiradas.length) {
    try {
      await notifyWhatsApp(env, montarAvisoAcoes(env, enfileiradas));
    } catch (e) {
      console.error("WhatsApp:", e.message);
    }
  }

  return {
    ok: true,
    campanhas: campaigns.length,
    anuncios: ads.length,
    gasto: account?.spend ?? null,
    vencedor: ads[0]?.name || null,
    acoes_pendentes: enfileiradas.length,
  };
}

// Valida as ações propostas (IA + regra), aplica os guardrails e enfileira como
// PENDENTES (nada é executado aqui — você aprova depois pelo WhatsApp/dashboard).
async function enqueueActions(env, runId, acoes, campaigns, ads) {
  if (!Array.isArray(acoes) || !acoes.length) return [];

  const adById = {};
  for (const a of ads) adById[String(a.id)] = a;
  const campById = {};
  for (const c of campaigns) campById[String(c.id)] = c;

  // Não duplica: pega o que já está pendente (mesmo alvo + mesmo tipo)
  const pend = await env.DB
    .prepare("SELECT target_id, action_type FROM actions WHERE status = 'pending'")
    .all();
  const jaPendente = new Set(
    (pend.results || []).map((r) => r.target_id + "|" + r.action_type)
  );

  const now = new Date().toISOString();
  const enfileiradas = [];

  for (const raw of acoes.slice(0, MAX_ACOES)) {
    const tipo = String(raw.tipo || "").toLowerCase();
    const nivel = raw.nivel === "campaign" ? "campaign" : "ad";
    const targetId = String(raw.target_id || "").trim();
    if (!ACOES_VALIDAS.includes(tipo) || !targetId) continue;

    // O alvo precisa existir nos dados coletados (evita id alucinado pela IA)
    const ref = nivel === "campaign" ? campById[targetId] : adById[targetId];
    if (!ref) continue;

    if (jaPendente.has(targetId + "|" + tipo)) continue;

    // Clampa o percentual de verba para a faixa segura
    let percent = null;
    if (tipo === "escalar" || tipo === "reduzir") {
      percent = Math.round(Number(raw.percent) || 0);
      if (!percent) percent = BUDGET_STEP_MIN;
      percent = Math.max(BUDGET_STEP_MIN, Math.min(BUDGET_STEP_MAX, percent));
    }

    const snapshot = {
      gasto: ref.spend,
      ctr: ref.ctr,
      checkouts: ref.checkouts,
      conversoes: ref.conversions,
      cpa: ref.cpa,
      frequencia: ref.frequency,
    };
    const nome = raw.target_nome || ref.name || "(sem nome)";
    const motivo = String(raw.motivo || "");
    const token = crypto.randomUUID();

    const ins = await env.DB
      .prepare(
        "INSERT INTO actions (run_id, created_at, level, target_id, target_name, action_type, percent, reason, metric_json, token, status) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')"
      )
      .bind(runId, now, nivel, targetId, nome, tipo, percent, motivo, JSON.stringify(snapshot), token)
      .run();

    jaPendente.add(targetId + "|" + tipo);
    enfileiradas.push({
      id: ins?.meta?.last_row_id || null,
      token,
      level: nivel,
      action_type: tipo,
      target_name: nome,
      percent,
      reason: motivo,
    });
  }

  return enfileiradas;
}

// Regra determinística (Fase 2): aponta anúncios claramente perdedores para
// PAUSAR. Métrica-alvo: Checkouts/CTR. Conservadora — só age com dados suficientes.
function detectLosers(account, ads) {
  const accCtr = account && account.ctr ? account.ctr : null;
  const accCpa = account && account.cpa ? account.cpa : null;
  const avgSpend = ads.length ? ads.reduce((s, a) => s + a.spend, 0) / ads.length : 0;
  const spendFloor = SPEND_FLOOR_MULT * (accCpa || avgSpend);

  const out = [];
  for (const a of ads) {
    if (a.impressions < MIN_IMPRESSOES_REGRA) continue; // dados insuficientes
    if (!spendFloor || a.spend < spendFloor) continue;  // gastou pouco: deixa rodar
    const semIntencao = a.checkouts === 0 && a.conversions === 0;
    if (!semIntencao) continue;
    const ctrFraco = accCtr ? a.ctr < CTR_FRACO_FRACAO * accCtr : false;
    // Sem CTR de referência, o gasto alto sem nenhum sinal já basta.
    if (!accCtr || ctrFraco) {
      out.push({
        nivel: "ad",
        target_id: String(a.id),
        target_nome: a.name,
        tipo: "pausar",
        percent: null,
        motivo:
          "Regra automática: gastou " + round2(a.spend) + " sem checkouts nem compras" +
          (ctrFraco ? " e CTR " + a.ctr + "% abaixo da metade da conta (" + accCtr + "%)" : "") + ".",
      });
    }
  }
  return out;
}

// Regra determinística (Fase 3): aponta a melhor CAMPANHA para ESCALAR verba.
// Vencedor claro pela métrica-alvo (Checkouts/CTR), com volume e sem fadiga.
// Escala no nível da campanha (onde fica a verba no CBO). Só propõe — você aprova.
function detectWinners(account, campaigns) {
  const accCtr = account && account.ctr ? account.ctr : null;

  const elegiveis = campaigns.filter((c) => {
    if (c.impressions < MIN_IMPRESSOES_REGRA) return false; // dados insuficientes
    if (c.frequency && c.frequency > FREQ_FADIGA) return false; // fadiga: não escala
    const temIntencao = c.checkouts > 0 || c.conversions > 0;
    const ctrForte = accCtr ? c.ctr >= accCtr : false;
    return temIntencao && ctrForte; // sinal real + atrai acima da média
  });
  if (!elegiveis.length) return [];

  // Melhor primeiro: mais checkouts, depois maior CTR
  elegiveis.sort((a, b) => (b.checkouts - a.checkouts) || (b.ctr - a.ctr));

  return elegiveis.slice(0, MAX_ESCALAR_POR_RUN).map((c) => ({
    nivel: "campaign",
    target_id: String(c.id),
    target_nome: c.name,
    tipo: "escalar",
    percent: ESCALAR_PCT_PADRAO,
    motivo:
      "Regra automática: vencedora pela métrica-alvo — " + c.checkouts + " checkouts" +
      (accCtr ? " e CTR " + c.ctr + "% (acima da conta, " + accCtr + "%)" : "") +
      ", sem fadiga (freq " + (c.frequency || 0) + ").",
  }));
}

// Insights agregados da conta inteira no período
async function fetchAccountInsights(env) {
  const { token, account } = meta(env);
  const fields =
    "spend,impressions,clicks,ctr,cpc,cpm,frequency,actions,action_values,purchase_roas";
  const url =
    META_API + "/" + account + "/insights" +
    "?level=account&date_preset=" + PERIODO +
    "&fields=" + encodeURIComponent(fields) +
    "&access_token=" + token;

  const res = await fetch(url);
  const data = await res.json();
  if (data.error) throw new Error("Meta API (conta): " + data.error.message);

  const row = data.data && data.data[0];
  if (!row) return null;
  return Object.assign({ name: "Conta inteira" }, computeFromInsight(row));
}

// Série diária da conta (uma linha por dia) para a tendência real
async function fetchDailySeries(env) {
  const { token, account } = meta(env);
  const fields = "spend,actions,action_values,purchase_roas";
  const url =
    META_API + "/" + account + "/insights" +
    "?level=account&time_increment=1&date_preset=last_" + DIAS_TENDENCIA + "d" +
    "&fields=" + encodeURIComponent(fields) +
    "&limit=" + (DIAS_TENDENCIA + 2) + "&access_token=" + token;

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
  const { token, account } = meta(env);
  const fields =
    "campaign_id,campaign_name,spend,impressions,clicks,ctr,cpc,cpm,frequency,actions,action_values,purchase_roas";
  const url =
    META_API + "/" + account + "/insights" +
    "?level=campaign&date_preset=" + PERIODO +
    "&fields=" + encodeURIComponent(fields) +
    "&limit=200&access_token=" + token;

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
  const { token, account } = meta(env);
  const fields =
    "name,effective_status," +
    "creative{image_url,thumbnail_url,body,title,video_id,object_story_spec}," +
    "insights.date_preset(" + PERIODO + "){spend,impressions,clicks,ctr,cpc,cpm,frequency,actions,action_values,purchase_roas}";
  const filtering = JSON.stringify([
    { field: "effective_status", operator: "IN", value: ["ACTIVE"] },
  ]);

  const url =
    META_API + "/" + account + "/ads" +
    "?fields=" + encodeURIComponent(fields) +
    "&filtering=" + encodeURIComponent(filtering) +
    "&limit=50&access_token=" + token;

  const res = await fetch(url);
  const data = await res.json();
  if (data.error) throw new Error("Meta API (anúncios): " + data.error.message);

  return (data.data || [])
    .filter((a) => a.insights && a.insights.data && a.insights.data[0])
    .map((a) => {
      const m = computeFromInsight(a.insights.data[0]);
      const c = a.creative || {};
      const oss = c.object_story_spec || {};
      const ld = oss.link_data || {};
      const vd = oss.video_data || {};
      const isVideo = !!(c.video_id || oss.video_data);
      const link =
        ld.link ||
        (vd.call_to_action && vd.call_to_action.value && vd.call_to_action.value.link) ||
        (ld.call_to_action && ld.call_to_action.value && ld.call_to_action.value.link) ||
        null;
      return Object.assign(
        {
          id: a.id,
          name: a.name,
          format: isVideo ? "video" : "image",
          link,
          // Para vídeo, thumbnail_url já é o frame de capa; usamos o que houver.
          image: c.image_url || c.thumbnail_url || vd.image_url || null,
          title: c.title || ld.name || vd.title || "",
          copy: c.body || ld.message || vd.message || "",
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
// Despachante: usa o Claude (Opus 4.8) quando há ANTHROPIC_API_KEY; senão, Gemini.
async function analyze(env, account, campaigns, ads) {
  const landings = await fetchLandingPages(ads);
  const { systemInstruction, text } = buildAnalysisPrompt(account, campaigns, ads, landings);
  const images = await fetchAdImages(ads);
  if (String(env.ANTHROPIC_API_KEY || "").trim()) {
    return await analyzeWithClaude(env, systemInstruction, text, images);
  }
  return await analyzeWithGemini(env, systemInstruction, text, images);
}

// Monta o system prompt + o texto com os dados (comum aos dois provedores).
function buildAnalysisPrompt(account, campaigns, ads, landings) {
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
    formato: a.format || "image",
    link: a.link || null,
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
    "MÉTRICA-ALVO DESTA CONTA: CHECKOUTS (Initiate Checkout) e CTR — é low-ticket com poucas compras, então " +
    "use checkouts como evento-ponte de intenção e CTR como sinal de atração do criativo. Use CPA/ROAS só como apoio. " +
    "Se houver compras mas receita/ROAS vierem zerados, sinalize que o CAPI provavelmente não está enviando o valor da compra. " +
    "Gere uma lista CURTA de sugestões priorizadas e acionáveis.\n\n" +
    "FORMATO DO CRIATIVO: cada anúncio tem 'formato' (image|video). Para vídeo, a imagem enviada é apenas o FRAME DE CAPA (thumbnail) — avalie a capa e a copy, e não conclua nada sobre o miolo do vídeo que não dê pra inferir da capa.\n" +
    "LANDING PAGE: quando houver a seção LANDING PAGES, avalie a página de destino (headline, oferta, prova social, clareza do CTA) E principalmente a COERÊNCIA anúncio→página: se a promessa/ângulo do criativo bate com o que a LP entrega. Quebra de coerência aí costuma explicar CTR bom com checkout/compra baixos.\n\n" +
    "ALÉM DISSO, proponha AÇÕES EXECUTÁVEIS no array 'acoes' (no máximo " + MAX_ACOES + ", as mais importantes). Regras rígidas:\n" +
    "- tipo 'pausar': só para anúncio/campanha com gasto relevante E checkouts/CTR claramente ABAIXO da média da conta (perdedor evidente).\n" +
    "- tipo 'escalar': só para vencedor CLARO (melhor checkout-rate/CTR com volume), 'percent' entre " + BUDGET_STEP_MIN + " e " + BUDGET_STEP_MAX + ".\n" +
    "- tipo 'reduzir': para item caro mas ainda não morto, 'percent' entre " + BUDGET_STEP_MIN + " e " + BUDGET_STEP_MAX + ".\n" +
    "- NUNCA proponha ação para item com dados insuficientes (gasto baixo / poucos dias).\n" +
    "- 'nivel' é 'ad' (use o ad_id) ou 'campaign' (use o campaign_id). 'percent' é null quando tipo='pausar'.\n" +
    "- O usuário ainda aprova cada ação no celular antes de executar — seja criterioso, não inunde a fila.\n\n" +
    "Responda SOMENTE com JSON válido, sem markdown, neste formato:\n" +
    '{ "resumo": "visão geral do negócio em 2-3 frases", ' +
    '"saude_conta": "diagnóstico da conta como um todo", ' +
    '"sugestoes_prioritarias": ["ação 1", "ação 2", "ação 3"], ' +
    '"acoes": [ { "nivel": "ad", "target_id": "...", "target_nome": "...", "tipo": "pausar", "percent": null, "motivo": "..." } ], ' +
    '"campanhas": [ { "campaign_id": "...", "diagnostico": "...", "melhorias": ["..."] } ], ' +
    '"vencedor": { "ad_id": "...", "pontos_fortes": ["..."], "melhorias": ["..."] }, ' +
    '"criativos": [ { "ad_id": "...", "diagnostico": "...", "melhorias": ["..."] } ], ' +
    '"landing_pages": [ { "url": "...", "diagnostico": "...", "coerencia_anuncio_lp": "...", "melhorias": ["..."] } ] }';

  const lpTabela = (landings || []).map((l) => ({
    url: l.url,
    ad_id: l.ad_id,
    texto: l.text,
  }));

  const text =
    "Dados da conta no período (" + PERIODO + "). Anúncios já ranqueados (rank 1 = melhor, por menor CPA " +
    "ou maior CTR). As imagens dos criativos vêm logo abaixo, na ordem do ranking.\n\n" +
    "CONTA:\n" + JSON.stringify(contaResumo, null, 2) +
    "\n\nCAMPANHAS:\n" + JSON.stringify(campanhasTabela, null, 2) +
    "\n\nANÚNCIOS:\n" + JSON.stringify(adsTabela, null, 2) +
    (lpTabela.length ? "\n\nLANDING PAGES (texto extraído das páginas de destino):\n" + JSON.stringify(lpTabela, null, 2) : "");

  return { systemInstruction, text };
}

// Baixa as imagens dos criativos top e devolve em base64 (comum aos provedores).
async function fetchAdImages(ads) {
  const out = [];
  for (const a of ads.slice(0, MAX_IMAGENS)) {
    if (!a.image) continue;
    try {
      const imgRes = await fetch(a.image);
      const bytes = new Uint8Array(await imgRes.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
      out.push({ rank: a.rank, name: a.name, id: a.id, base64: btoa(binary) });
    } catch (e) {
      console.error("Erro ao baixar imagem do ad " + a.id + ": ", e);
    }
  }
  return out;
}

// Baixa o texto das landing pages de destino (links únicos, na ordem do ranking).
async function fetchLandingPages(ads) {
  const seen = new Set();
  const targets = [];
  for (const a of ads) {
    if (a.link && !seen.has(a.link)) {
      seen.add(a.link);
      targets.push({ url: a.link, ad_id: a.id });
      if (targets.length >= MAX_LPS) break;
    }
  }

  const out = [];
  for (const t of targets) {
    try {
      const res = await fetch(t.url, {
        redirect: "follow",
        headers: { "user-agent": "Mozilla/5.0 (compatible; MetaAdsAnalyst/1.0)" },
      });
      const html = await res.text();
      out.push({ url: t.url, ad_id: t.ad_id, text: htmlToText(html).slice(0, LP_CHARS) });
    } catch (e) {
      console.error("Erro ao baixar LP " + t.url + ": ", e.message);
    }
  }
  return out;
}

// Converte HTML em texto plano (remove script/style/tags, decodifica entidades básicas).
function htmlToText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// Extrai o JSON do texto devolvido pela IA (tolera cercas ```json).
function parseAnalysisJson(text) {
  const clean = String(text || "{}").replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(clean);
  } catch {
    return { resumo: clean }; // fallback: guarda o texto bruto
  }
}

// --- Provedor: Claude (Opus 4.8) via Anthropic Messages API ---
async function analyzeWithClaude(env, systemInstruction, text, images) {
  const content = [{ type: "text", text }];
  for (const img of images) {
    content.push({ type: "text", text: "Imagem do criativo rank " + img.rank + " — " + img.name + " (ad_id " + img.id + "):" });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: img.base64 } });
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": String(env.ANTHROPIC_API_KEY).trim(),
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 8000,
      system: systemInstruction + "\nResponda apenas com o objeto JSON, sem texto antes ou depois.",
      messages: [{ role: "user", content }],
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error("Claude API: " + (data.error.message || JSON.stringify(data.error)));

  const block = (data.content || []).find((b) => b.type === "text");
  return parseAnalysisJson(block ? block.text : "{}");
}

// --- Provedor: Gemini ---
async function analyzeWithGemini(env, systemInstruction, text, images) {
  const parts = [{ text }];
  for (const img of images) {
    parts.push({ text: "Imagem do criativo rank " + img.rank + " — " + img.name + " (ad_id " + img.id + "):" });
    parts.push({ inline_data: { mime_type: "image/jpeg", data: img.base64 } });
  }

  const body = JSON.stringify({
    contents: [{ parts }],
    system_instruction: { parts: [{ text: systemInstruction }] },
    generationConfig: { responseMimeType: "application/json" },
  });

  let lastErr = "";
  for (const model of GEMINI_MODELS) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
      { method: "POST", headers: { "content-type": "application/json" }, body }
    );
    const data = await res.json();

    if (data.error) {
      lastErr = data.error.message;
      if (/not found|not supported|does not exist/i.test(lastErr)) continue;
      throw new Error("Gemini API: " + lastErr);
    }

    return parseAnalysisJson(data.candidates?.[0]?.content?.parts?.[0]?.text);
  }

  throw new Error("Gemini API: nenhum modelo disponível (" + lastErr + ")");
}

// ---------------- Executor de ações (Fase 1) ----------------

// Decisão vinda do dashboard (autenticada pela DASH_KEY): só precisa do id.
async function decideAction(env, id, decision) {
  const row = await env.DB.prepare("SELECT * FROM actions WHERE id = ?").bind(id).first();
  if (!row) return { ok: false, error: "Ação não encontrada." };
  return await applyDecision(env, row, decision);
}

// Decisão vinda do link de 1 toque do WhatsApp: o token autoriza (sem DASH_KEY).
async function decideActionByToken(env, id, token, decision) {
  const row = await env.DB.prepare("SELECT * FROM actions WHERE id = ?").bind(id).first();
  if (!row) return { ok: false, error: "Ação não encontrada." };
  if (!row.token || !token || row.token !== token) {
    return { ok: false, error: "Link inválido ou expirado." };
  }
  return await applyDecision(env, row, decision);
}

// Núcleo: aplica a decisão a uma ação pendente.
// 'reject' apenas marca; 'approve' executa de verdade na Meta API.
async function applyDecision(env, row, decision) {
  if (row.status !== "pending") {
    return { ok: false, status: row.status, error: "Ação já foi decidida (" + row.status + ").", target_name: row.target_name, action_type: row.action_type };
  }

  const now = new Date().toISOString();

  if (decision === "reject") {
    await env.DB
      .prepare("UPDATE actions SET status='rejected', decided_at=? WHERE id=?")
      .bind(now, row.id)
      .run();
    return { ok: true, status: "rejected", target_name: row.target_name, action_type: row.action_type };
  }

  // approve → executa na Meta e registra o resultado
  try {
    const result = await executeAction(env, row);
    await env.DB
      .prepare("UPDATE actions SET status='approved', result=?, decided_at=? WHERE id=?")
      .bind(JSON.stringify(result), now, row.id)
      .run();
    return { ok: true, status: "approved", result, target_name: row.target_name, action_type: row.action_type };
  } catch (e) {
    await env.DB
      .prepare("UPDATE actions SET status='failed', result=?, decided_at=? WHERE id=?")
      .bind(String(e.message), now, row.id)
      .run();
    return { ok: false, status: "failed", error: e.message, target_name: row.target_name, action_type: row.action_type };
  }
}

// Traduz a ação aprovada em chamada de escrita na Meta Marketing API.
// Requer um token com permissão ads_management (read não basta para escrever).
async function executeAction(env, row) {
  const { token } = meta(env);
  if (!token) throw new Error("META_TOKEN ausente.");

  if (row.action_type === "pausar") {
    return await metaWrite(token, row.target_id, { status: "PAUSED" });
  }

  if (row.action_type === "escalar" || row.action_type === "reduzir") {
    const info = await metaRead(token, row.target_id, "name,daily_budget,lifetime_budget,status");
    const isDaily = info.daily_budget != null;
    const campo = isDaily ? "daily_budget" : "lifetime_budget";
    const atual = Number(info.daily_budget || info.lifetime_budget || 0); // centavos
    if (!atual) {
      throw new Error("Este alvo não tem orçamento próprio — a verba pode estar no adset ou no CBO em outro nível.");
    }

    const pct = Number(row.percent) || BUDGET_STEP_MIN;
    const fator = row.action_type === "escalar" ? 1 + pct / 100 : 1 - pct / 100;
    let novo = Math.round(atual * fator);
    if (row.action_type === "reduzir") novo = Math.max(BUDGET_PISO_CENTS, novo);

    const r = await metaWrite(token, row.target_id, { [campo]: String(novo) });
    return Object.assign({ campo, verba_anterior: atual, verba_nova: novo }, r);
  }

  throw new Error("Tipo de ação desconhecido: " + row.action_type);
}

async function metaRead(token, id, fields) {
  const url = META_API + "/" + id + "?fields=" + encodeURIComponent(fields) + "&access_token=" + token;
  const res = await fetch(url);
  const data = await res.json();
  if (data.error) throw new Error("Meta API (leitura): " + data.error.message);
  return data;
}

async function metaWrite(token, id, params) {
  const form = new URLSearchParams();
  for (const k in params) form.set(k, params[k]);
  form.set("access_token", token);
  const res = await fetch(META_API + "/" + id, { method: "POST", body: form });
  const data = await res.json();
  if (data.error) throw new Error("Meta API (escrita): " + data.error.message);
  return data;
}

// ---------------- Notificação (WhatsApp via CallMeBot) ----------------

// Monta a mensagem listando as ações novas. Quando há DASH_URL, cada ação vem
// com link de Aprovar/Rejeitar de 1 toque (autorização direto do WhatsApp).
function montarAvisoAcoes(env, lista) {
  const base = String(env.DASH_URL || "").trim().replace(/\/+$/, "");

  const blocos = lista.map((a) => {
    const verba =
      (a.action_type === "escalar" || a.action_type === "reduzir") && a.percent
        ? " " + (a.action_type === "escalar" ? "+" : "-") + a.percent + "%"
        : "";
    let bloco = "• " + a.action_type.toUpperCase() + verba + ": " + a.target_name;
    if (a.reason) bloco += "\n  " + a.reason;
    if (base && a.id && a.token) {
      const q = "id=" + a.id + "&t=" + a.token + "&d=";
      bloco += "\n  ✅ Aprovar: " + base + "/act?" + q + "approve";
      bloco += "\n  ❌ Rejeitar: " + base + "/act?" + q + "reject";
    }
    return bloco;
  });

  return (
    "🔔 Meta Ads Analyst — autorização necessária\n" +
    lista.length + " ação(ões) propostas:\n\n" +
    blocos.join("\n\n") +
    (base ? "" : "\n\nAbra o painel para aprovar/rejeitar.")
  );
}

// Envia a mensagem pelo CallMeBot. Sem apikey/telefone, não faz nada (silencioso).
async function notifyWhatsApp(env, text) {
  const apikey = String(env.CALLMEBOT_APIKEY || "").trim();
  const phone = String(env.WHATSAPP_PHONE || WHATSAPP_PHONE || "").trim().replace(/\D/g, "");
  if (!apikey || !phone) return;

  const url =
    "https://api.callmebot.com/whatsapp.php?phone=" + encodeURIComponent(phone) +
    "&text=" + encodeURIComponent(text) +
    "&apikey=" + encodeURIComponent(apikey);

  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error("CallMeBot " + res.status + ": " + body.slice(0, 200));
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

  // Fila de ações propostas pela IA (Fase 1: ficam pendentes até você aprovar)
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS actions (" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
      "run_id INTEGER, " +
      "created_at TEXT NOT NULL, " +
      "level TEXT, " +           // 'ad' | 'campaign'
      "target_id TEXT, " +       // id na Meta
      "target_name TEXT, " +
      "action_type TEXT, " +     // 'pausar' | 'escalar' | 'reduzir'
      "percent INTEGER, " +      // % de ajuste de verba (só escalar/reduzir)
      "reason TEXT, " +          // por que a ação foi proposta
      "metric_json TEXT, " +     // snapshot das métricas no momento
      "token TEXT, " +           // segredo p/ aprovar via link de 1 toque
      "status TEXT NOT NULL DEFAULT 'pending', " + // pending|approved|rejected|failed
      "result TEXT, " +          // retorno da execução / erro
      "decided_at TEXT)"
  ).run();

  // Migração suave: token em bancos antigos
  try {
    await env.DB.prepare("ALTER TABLE actions ADD COLUMN token TEXT").run();
  } catch (e) {
    /* coluna já existe */
  }
}

// Lê e normaliza credenciais da Meta (remove espaços/aspas/quebras coladas por engano)
function meta(env) {
  const clean = (v) => String(v || "").trim().replace(/^["']|["']$/g, "");
  return { token: clean(env.META_TOKEN), account: clean(env.META_AD_ACCOUNT) };
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

// Página simples de confirmação para os links de 1 toque do WhatsApp
function htmlPage(titulo, msg, ok) {
  const cor = ok ? "#067647" : "#B42318";
  const esc = (s) => String(s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const body =
    "<!DOCTYPE html><html lang='pt-BR'><head><meta charset='UTF-8'>" +
    "<meta name='viewport' content='width=device-width, initial-scale=1'>" +
    "<title>" + esc(titulo) + "</title></head>" +
    "<body style='font-family:system-ui,sans-serif;background:#ECEDEA;color:#17191C;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px'>" +
    "<div style='background:#fff;border:1.5px solid #D8DAD4;border-radius:16px;padding:28px;max-width:420px;text-align:center'>" +
    "<h1 style='color:" + cor + ";font-size:22px;margin:0 0 10px'>" + esc(titulo) + "</h1>" +
    "<p style='color:#6B7280;font-size:15px;margin:0'>" + esc(msg) + "</p>" +
    "</div></body></html>";
  return new Response(body, { status: 200, headers: { "content-type": "text/html;charset=utf-8" } });
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
  .alert{background:#FEF3C7;border:1.5px solid var(--gold);color:#7A4F01;border-radius:12px;padding:12px 14px;margin-bottom:16px;font-size:14px;font-weight:600}
  .trend{background:var(--card);border:1.5px solid var(--line);border-radius:12px;padding:14px;margin-bottom:16px}
  .trend svg{display:block;width:100%;height:48px;margin-top:8px}
  .trend polyline{fill:none;stroke:var(--blue);stroke-width:2}
  .empty{text-align:center;color:var(--muted);padding:50px 20px}
  .err{color:var(--bad);font-weight:600}
  .badge{display:inline-block;min-width:18px;text-align:center;background:var(--bad);color:#fff;font-family:'Spline Sans Mono',monospace;font-size:11px;font-weight:600;border-radius:9px;padding:1px 6px;margin-left:2px}
  .pill{display:inline-block;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.6px;border-radius:6px;padding:3px 8px;margin-bottom:8px}
  .pill.pausar{background:#FEE4E2;color:var(--bad)} .pill.reduzir{background:#FEF0C7;color:var(--gold)} .pill.escalar{background:#DCFAE6;color:var(--good)}
  .why{color:var(--muted);font-size:13px;margin:8px 0 12px}
  .acts{display:flex;gap:8px}
  .acts .ok{flex:1;background:var(--good);border-color:var(--good)}
  .acts .no{flex:1;background:var(--card);color:var(--ink)}
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
  <button class="tab" data-tab="actions">Ações <span id="actbadge" class="badge" style="display:none">0</span></button>
  <button class="tab" data-tab="campaigns">Campanhas</button>
  <button class="tab" data-tab="creatives">Criativos</button>
</div>

<div id="app"></div>

<script>
(function(){
  var KEY = localStorage.getItem("dashkey") || "";
  var TAB = "overview";
  var DATA = null, HISTORY = [], ACTIONS = [];
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

    if (acc.conversions > 0 && !acc.revenue) {
      html += '<div class="alert">⚠ ' + fmt(acc.conversions) + ' conversões e R$ 0 de receita — o CAPI provavelmente não está enviando o valor da compra. Sem isso, o ROAS fica cego.</div>';
    }

    var daily = DATA.daily || [];
    var spendSeries = daily.length ? daily.map(function(d){ return d.spend; }) : HISTORY.map(function(h){ return h.spend; });
    var trendLabel = daily.length ? ("Gasto diário · últimos " + daily.length + " dias") : "Gasto ao longo dos snapshots";
    var spark = sparkline(spendSeries);
    if (spark) {
      html += '<div class="trend"><div class="sec">' + trendLabel + '</div>' + spark + '</div>';
    }
    if (daily.length) {
      var cpaSpark = sparkline(daily.map(function(d){ return d.cpa; }));
      if (cpaSpark) html += '<div class="trend"><div class="sec">CPA diário · últimos ' + daily.length + ' dias</div>' + cpaSpark + '</div>';
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

    var lps = an.landing_pages || [];
    for (var li = 0; li < lps.length; li++) {
      var lp = lps[li];
      html += '<div class="card">';
      html += '<div class="sec">Landing page</div>';
      if (lp.url) html += '<div class="rank" style="word-break:break-all">' + esc(lp.url) + '</div>';
      if (lp.diagnostico) html += '<p class="diag">' + esc(lp.diagnostico) + '</p>';
      if (lp.coerencia_anuncio_lp) html += '<div class="sec">Coerência anúncio → página</div><p class="diag">' + esc(lp.coerencia_anuncio_lp) + '</p>';
      if (lp.melhorias && lp.melhorias.length) html += '<div class="sec blue">Melhorias propostas</div>' + listHtml(lp.melhorias);
      html += '</div>';
    }

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
      var fmtLabel = a.format === "video" ? " · 🎬 vídeo (capa)" : "";
      html += '<div class="rank">Rank ' + a.rank + " de " + ads.length + fmtLabel + '</div>';
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

  function fmtMetric(m){
    if (!m) return "";
    var bits = [];
    if (m.gasto != null) bits.push("Gasto " + fmt(m.gasto, true));
    if (m.ctr != null) bits.push("CTR " + fmt(m.ctr) + "%");
    if (m.checkouts != null) bits.push("Checkouts " + fmt(m.checkouts));
    if (m.cpa != null) bits.push("CPA " + fmt(m.cpa, true));
    return bits.join(" · ");
  }

  function updateBadge(){
    var b = document.getElementById("actbadge");
    if (ACTIONS.length) { b.textContent = ACTIONS.length; b.style.display = "inline-block"; }
    else b.style.display = "none";
  }

  function decide(id, decision, btn){
    var card = btn.closest(".card");
    Array.prototype.forEach.call(card.querySelectorAll("button"), function(x){ x.disabled = true; });
    btn.textContent = decision === "approve" ? "Aplicando..." : "Removendo...";
    fetch("/api/actions/decide?key=" + encodeURIComponent(KEY), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: id, decision: decision })
    }).then(function(r){ return r.json(); }).then(function(res){
      if (res.error) { alert(res.error); }
      ACTIONS = ACTIONS.filter(function(a){ return a.id !== id; });
      updateBadge();
      renderActions();
    }).catch(function(){
      alert("Falha de rede ao decidir a ação.");
      renderActions();
    });
  }

  function renderActions(){
    if (!ACTIONS.length) {
      app.innerHTML = '<div class="empty">Nenhuma ação pendente. A IA propõe ações (pausar / escalar / reduzir verba) na próxima análise; aqui você aprova ou rejeita.</div>';
      return;
    }
    var html = "";
    for (var i = 0; i < ACTIONS.length; i++) {
      var a = ACTIONS[i];
      var verba = (a.action_type === "escalar" || a.action_type === "reduzir") && a.percent
        ? (a.action_type === "escalar" ? "+" : "−") + a.percent + "% de verba" : "";
      var alvo = a.level === "campaign" ? "Campanha" : "Anúncio";
      html += '<div class="card">';
      html += '<span class="pill ' + esc(a.action_type) + '">' + esc(a.action_type) + (verba ? " · " + esc(verba) : "") + '</span>';
      html += '<div class="adname">' + esc(a.target_name) + '</div>';
      html += '<div class="rank">' + alvo + ' · ' + esc(fmtMetric(a.metric)) + '</div>';
      html += '<p class="why">' + esc(a.reason) + '</p>';
      html += '<div class="acts">'
        + '<button class="ok" data-id="' + a.id + '" data-dec="approve">Aprovar</button>'
        + '<button class="no" data-id="' + a.id + '" data-dec="reject">Rejeitar</button>'
        + '</div>';
      html += '</div>';
    }
    app.innerHTML = html;
    Array.prototype.forEach.call(app.querySelectorAll(".acts button"), function(btn){
      btn.onclick = function(){ decide(Number(btn.getAttribute("data-id")), btn.getAttribute("data-dec"), btn); };
    });
  }

  function render(){
    if (TAB === "actions") { updateBadge(); renderActions();
      if (DATA) document.getElementById("ts").textContent = "· atualizado " + new Date(DATA.created_at).toLocaleString("pt-BR");
      return;
    }
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
      fetch("/api/actions?key=" + encodeURIComponent(KEY)).then(function(r){ return r.json(); }).catch(function(){ return []; }),
    ]).then(function(arr){
      DATA = arr[0];
      HISTORY = arr[1] || [];
      ACTIONS = Array.isArray(arr[2]) ? arr[2] : [];
      keybox.style.display = "none";
      tabs.style.display = (DATA || ACTIONS.length) ? "flex" : "none";
      runbtn.style.display = "inline-block";
      updateBadge();
      render();
    }).catch(function(){});
  }

  if (KEY) { keybox.style.display = "none"; load(); }
})();
</script>
</body>
</html>`;
