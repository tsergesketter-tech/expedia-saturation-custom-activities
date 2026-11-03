// Stub "Expedia Saturation Model". Deterministic, explainable scoring so the demo
// outputs look like a real model: score in [0,1], send/abstain, reason codes.
// PROTOTYPE for illustration only: not a real model.

export const MODEL_VERSION = 'sat-gbm-2026.10.3';

const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));

// One Key members at higher tiers tolerate more contact before fatiguing.
const TIER_TOLERANCE = { Blue: 0, Silver: 0.03, Gold: 0.06, Platinum: 0.1 };

export function score(traveler, { threshold = 0.65 } = {}) {
  const f = traveler.features;
  const parts = {
    sendPressure7d: 0.34 * clamp(f.sends7d / 6),
    sendPressure30d: 0.18 * clamp(f.sends30d / 20),
    lowOpenRate: 0.2 * clamp(1 - f.openRate30d / 0.35),
    lowClickRate: 0.1 * clamp(1 - f.clickRate30d / 0.06),
    disengagement: 0.12 * clamp(f.daysSinceLastEngaged / 45),
    complaintSignal: f.unsubPageViews30d > 0 ? 0.06 * clamp(f.unsubPageViews30d / 2) : 0,
  };
  // An imminent trip makes messages more relevant (pre-trip upsell), lowering saturation.
  const tripRelief = f.daysToNextTrip != null && f.daysToNextTrip <= 21 ? 0.08 : 0;
  const tolerance = TIER_TOLERANCE[traveler.tier] ?? 0;
  const raw = Object.values(parts).reduce((a, b) => a + b, 0) - tripRelief - tolerance;
  const saturationScore = Math.round(clamp(raw) * 1000) / 1000;
  const prediction = saturationScore >= threshold ? 'abstain' : 'send';

  const reasons = Object.entries(parts)
    .filter(([, v]) => v >= 0.1)
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => REASON_CODES[k]);
  if (tripRelief) reasons.push('UPCOMING_TRIP_RELEVANCE');
  if (tolerance) reasons.push(`ONE_KEY_${traveler.tier.toUpperCase()}_TOLERANCE`);

  return {
    contactKey: traveler.contactKey,
    saturationScore,
    prediction,
    threshold,
    confidence: Math.round((0.5 + Math.abs(saturationScore - threshold)) * 100) / 100,
    reasonCodes: reasons.slice(0, 4),
    // Next safe send window: how long to hold off if abstaining.
    recommendedHoldHours: prediction === 'abstain' ? Math.round(24 + 72 * (saturationScore - threshold) / (1 - threshold)) : 0,
    modelVersion: MODEL_VERSION,
    scoredAt: new Date().toISOString(),
  };
}

const REASON_CODES = {
  sendPressure7d: 'HIGH_SEND_VOLUME_7D',
  sendPressure30d: 'HIGH_SEND_VOLUME_30D',
  lowOpenRate: 'DECLINING_OPEN_RATE',
  lowClickRate: 'LOW_CLICK_THROUGH',
  disengagement: 'DAYS_SINCE_ENGAGEMENT',
  complaintSignal: 'UNSUBSCRIBE_INTENT',
};
