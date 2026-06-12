# Criativo Judge 🏆

Avaliador automático de criativos do Meta Ads. A cada 12 horas, busca as métricas dos seus anúncios ativos (últimos 7 dias), ranqueia por CPA/CTR, e o Claude analisa a imagem + copy de cada criativo: por que o campeão venceu, o que está fraco nos demais e melhorias concretas. Tudo num dashboard mobile.

## Stack

- **Cloudflare Worker** com Cron Trigger (análise automática 2x/dia)
- **D1** (banco SQLite da Cloudflare) para histórico — a tabela é criada sozinha
- **Meta Marketing API** (métricas + imagem/copy dos criativos)
- **Anthropic API** (análise qualitativa com visão)

## Instalação (100% pelo celular)

### 1. Suba este repositório no GitHub
Crie um repo novo e envie estes arquivos (no app/site do GitHub: *Add file > Upload files*).

### 2. Crie o banco D1
No painel da Cloudflare: **Storage & Databases > D1 > Create database**, nome `criativo-judge`. Copie o **Database ID** e cole no `wrangler.toml` (edite direto pelo GitHub), no lugar de `COLE_O_ID_DO_BANCO_AQUI`.

### 3. Conecte o repo ao Cloudflare
**Workers & Pages > Create > Workers > Connect to Git** (importar repositório). Selecione o repo e faça o deploy. A partir daí, todo push no GitHub publica automaticamente.

### 4. Adicione os secrets
No Worker criado: **Settings > Variables and Secrets**, adicione como *Secret*:

| Nome | Valor |
|---|---|
| `META_TOKEN` | Token do System User com permissão `ads_read` |
| `META_AD_ACCOUNT` | ID da conta no formato `act_1234567890` |
| `ANTHROPIC_API_KEY` | Sua chave da API da Anthropic |
| `DASH_KEY` | Uma senha que você inventa para abrir o dashboard |

### 5. Pronto
Abra a URL do Worker (`https://criativo-judge.SEU-SUBDOMINIO.workers.dev`), digite sua `DASH_KEY` e toque em **Rodar análise** para gerar o primeiro veredito. Depois disso, o cron roda sozinho às 6h e 18h (UTC).

## Como funciona o ranking

1. **Com conversões** (compra ou lead): menor CPA vence.
2. **Sem conversões ainda**: maior CTR vence.
3. O Claude recebe métricas + imagens e devolve: pontos fortes do campeão, diagnóstico e melhorias de cada criativo, e alerta de fadiga quando a frequência passa de 2,5.

## Ajustes rápidos

- **Janela de análise**: mude `PERIODO` em `src/index.js` (`last_7d`, `last_14d`, `last_30d`...)
- **Frequência do cron**: edite `crons` no `wrangler.toml`
- **Quantidade de imagens enviadas à IA**: `MAX_IMAGENS` em `src/index.js`

## Custos

Worker + D1 + Cron cabem no plano gratuito da Cloudflare. O único custo variável é a API da Anthropic (~2 análises/dia com poucas imagens custa centavos).
