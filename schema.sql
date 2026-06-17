-- Schema do banco D1 (referência).
-- O Worker cria esta tabela automaticamente na primeira execução
-- e migra bancos antigos sozinho (ALTER TABLE), então você NÃO
-- precisa rodar este arquivo manualmente.

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  account_json TEXT,     -- métricas agregadas da conta
  campaigns_json TEXT,   -- métricas por campanha
  daily_json TEXT,       -- série diária da conta (tendência)
  metrics_json TEXT NOT NULL, -- métricas por anúncio (criativos)
  analysis_json TEXT     -- relatório da IA (resumo, sugestões, ações, diagnósticos)
);

-- Fila de ações de otimização propostas pela IA. Ficam 'pending' até você
-- aprovar/rejeitar no dashboard; ao aprovar, são executadas na Meta API.
CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER,
  created_at TEXT NOT NULL,
  level TEXT,            -- 'ad' | 'campaign'
  target_id TEXT,        -- id do alvo na Meta
  target_name TEXT,
  action_type TEXT,      -- 'pausar' | 'escalar' | 'reduzir'
  percent INTEGER,       -- % de ajuste de verba (escalar/reduzir)
  reason TEXT,           -- motivo dado pela IA
  metric_json TEXT,      -- snapshot das métricas no momento da proposta
  status TEXT NOT NULL DEFAULT 'pending', -- pending|approved|rejected|failed
  result TEXT,           -- retorno da execução ou mensagem de erro
  decided_at TEXT
);
