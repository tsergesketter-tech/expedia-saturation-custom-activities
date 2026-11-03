CREATE SCHEMA IF NOT EXISTS main.expedia_sat COMMENT 'Expedia send-saturation model outputs (POC)';
CREATE TABLE IF NOT EXISTS main.expedia_sat.saturation_predictions (
  contact_key STRING NOT NULL COMMENT 'MCE SubscriberKey / Expedia traveler id',
  saturation_score DOUBLE, prediction STRING COMMENT 'send | abstain', reason_codes STRING,
  recommended_hold_hours INT, model_version STRING, scoring_mode STRING COMMENT 'sync | async | batch | console',
  scored_at TIMESTAMP
) COMMENT 'Current prediction per traveler, federated into Data 360 (zero copy)'
TBLPROPERTIES ('delta.enableDeletionVectors'='false','delta.columnMapping.mode'='name','delta.enableIcebergCompatV2'='true','delta.universalFormat.enabledFormats'='iceberg');
CREATE TABLE IF NOT EXISTS main.expedia_sat.saturation_predictions_history (
  contact_key STRING NOT NULL, saturation_score DOUBLE, prediction STRING, reason_codes STRING,
  recommended_hold_hours INT, model_version STRING, scoring_mode STRING, scored_at TIMESTAMP
) COMMENT 'Append-only prediction log'
TBLPROPERTIES ('delta.enableDeletionVectors'='false','delta.columnMapping.mode'='name','delta.enableIcebergCompatV2'='true','delta.universalFormat.enabledFormats'='iceberg');
