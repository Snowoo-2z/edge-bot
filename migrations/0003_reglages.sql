-- Edge · les reglages personnalises (/edge config). Un module peut tout debrancher sans
-- retoucher le code : une ligne par reglage, la valeur en JSONB (le type est dans le code).
-- C'est la table que complete la voie « flags » (booleens, deja la depuis le debut) et
-- « kv_store » (les reglages nes avant celle-ci) : /edge config sait ou lire, pas toi.
CREATE TABLE IF NOT EXISTS module_settings (
  module_key TEXT NOT NULL,
  cle TEXT NOT NULL,
  valeur JSONB NOT NULL,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (module_key, cle)
);
CREATE INDEX IF NOT EXISTS module_settings_module_idx ON module_settings (module_key);
