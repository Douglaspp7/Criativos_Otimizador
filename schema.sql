-- Schema do banco D1 (referência).
-- O Worker cria esta tabela automaticamente na primeira execução
-- e migra bancos antigos sozinho (ALTER TABLE), então você NÃO
-- precisa rodar este arquivo manualmente.

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  account_json TEXT,     -- métricas agregadas da conta
  campaigns_json TEXT,   -- métricas por campanha
  metrics_json TEXT NOT NULL, -- métricas por anúncio (criativos)
  analysis_json TEXT     -- relatório da IA (resumo, sugestões, diagnósticos)
);
