# Meta Ads Analyst 📊

Painel de métricas do seu negócio no Meta Ads. A cada 12 horas o Worker coleta os insights da **conta inteira**, de **cada campanha** e de **cada anúncio ativo**, guarda um snapshot no banco e o Gemini gera um relatório: saúde da conta, diagnóstico por campanha, veredito dos criativos e uma lista de **sugestões priorizadas** (o que fazer primeiro). Além de avaliar, ele **propõe ações de otimização** (pausar / escalar / reduzir verba) que você **aprova com 1 toque no celular** — quando aprovadas, são executadas direto na Meta. Tudo num dashboard mobile.

## O que ele mostra

- **Visão geral** — KPIs da conta (gasto, conversões, CPA, ROAS, CTR, CPM), tendência de gasto ao longo dos snapshots e o resumo + sugestões da IA.
- **Ações** — fila de otimizações propostas pela IA. Cada card mostra o alvo, as métricas, o motivo e dois botões: **Aprovar** (executa na Meta) ou **Rejeitar**. A métrica-alvo desta conta é **Checkouts / CTR** (low-ticket, poucas compras).
- **Campanhas** — drill-down por campanha com métricas e diagnóstico/melhorias da IA.
- **Criativos** — ranking dos anúncios ativos por CPA/CTR, com análise de imagem + copy (o campeão ganha selo).

## Otimização automática (Fase 1: sugerir → aprovar → executar)

A análise gera, junto do relatório, uma lista de **ações executáveis** com guardrails rígidos:

- **pausar** — só para anúncio/campanha com gasto relevante e Checkouts/CTR claramente abaixo da média.
- **escalar / reduzir verba** — só para vencedor/perdedor claro; o ajuste fica travado entre **10% e 30%** por vez, com piso de verba para não zerar uma campanha.
- No máximo **5 ações por análise**, sem duplicar o que já está na fila.

Nada é executado sozinho: as ações ficam **pendentes** até você aprovar pelo dashboard. Por isso, para escrever na Meta (pausar, mexer em verba), o `META_TOKEN` precisa de permissão **`ads_management`** (a leitura usa `ads_read`). Toda decisão fica registrada no banco (`actions`).

## Stack

- **Cloudflare Worker** com Cron Trigger (análise automática 2x/dia)
- **D1** (banco SQLite da Cloudflare) para histórico — a tabela é criada e migrada sozinha
- **Meta Marketing API** (insights em 3 níveis: conta, campanha, anúncio + imagem/copy dos criativos)
- **Gemini 2.5 Pro** (relatório qualitativo com visão)

## Instalação (100% pelo celular)

### 1. Suba este repositório no GitHub
Crie um repo novo e envie estes arquivos (no app/site do GitHub: *Add file > Upload files*).

### 2. Crie o banco D1
No painel da Cloudflare: **Storage & Databases > D1 > Create database**, nome `criativo-judge`. Copie o **Database ID** e cole no `wrangler.toml` (edite direto pelo GitHub), no lugar do id atual.

### 3. Conecte o repo ao Cloudflare
**Workers & Pages > Create > Workers > Connect to Git** (importar repositório). Selecione o repo e faça o deploy. A partir daí, todo push no GitHub publica automaticamente.

### 4. Adicione os secrets
No Worker criado: **Settings > Variables and Secrets**, adicione como *Secret*:

| Nome | Valor |
|---|---|
| `META_TOKEN` | Token do System User. `ads_read` basta para avaliar; para **aprovar/executar ações** (pausar, mexer em verba) use `ads_management` |
| `META_AD_ACCOUNT` | ID da conta no formato `act_1234567890` |
| `GEMINI_API_KEY` | Sua chave da API do Gemini |

> A **senha do dashboard** fica direto no código: edite a constante `DASH_KEY` no topo de `src/index.js` (pelo GitHub mesmo) e troque `"troque-esta-senha"` pela sua. Não precisa configurar nada no Cloudflare. Se ainda assim quiser, dá pra definir um secret `DASH_KEY` no Worker — quando existe, ele tem prioridade.

### 5. Pronto
Abra a URL do Worker, digite a senha que você definiu na constante `DASH_KEY` e toque em **Rodar análise** para gerar o primeiro relatório. Depois disso, o cron roda sozinho às 6h e 18h (UTC).

## Como funciona

1. **Coleta** — uma chamada por nível na Meta API (conta, campanha, anúncio), no período definido por `PERIODO`.
2. **Métricas derivadas** — gasto, CTR, CPM, frequência, conversões (compra/lead), receita, CPA e ROAS por nível.
3. **Ranking de criativos** — com conversões, menor CPA vence; sem conversões, maior CTR.
4. **IA** — Gemini recebe conta + campanhas + criativos (com imagens) e devolve relatório em JSON: resumo, saúde da conta, sugestões priorizadas, diagnóstico por campanha e por criativo. Alerta de fadiga quando a frequência passa de 2,5.
5. **Snapshot** — cada execução vira uma linha no D1, alimentando a tendência da visão geral.

## Ajustes rápidos

- **Janela de análise**: mude `PERIODO` em `src/index.js` (`last_7d`, `last_14d`, `last_30d`, `maximum`...)
- **Frequência do cron**: edite `crons` no `wrangler.toml`
- **Imagens enviadas à IA**: `MAX_IMAGENS` em `src/index.js`
- **Campanhas analisadas/exibidas**: `MAX_CAMPANHAS` em `src/index.js`

## Custos

Worker + D1 + Cron cabem no plano gratuito da Cloudflare. O único custo variável é a API do Gemini (poucas análises/dia com poucas imagens custa centavos).
