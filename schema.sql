-- Schema do banco D1 (referência).
-- O Worker cria esta tabela automaticamente na primeira execução,
-- então você NÃO precisa rodar este arquivo manualmente.

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  analysis_json TEXT
);
