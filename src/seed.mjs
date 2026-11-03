// Seed travelers. Emails are plus-addressed off SEED_EMAIL (e.g. you@company.com).
const base = (process.env.SEED_EMAIL || 'demo@example.com').split('@');
const email = (tag) => `${base[0]}+exp-${tag}@${base[1]}`;

const t = (contactKey, firstName, lastName, tier, homeAirport, persona, features) => ({
  contactKey, firstName, lastName, email: email(firstName.toLowerCase()), tier, homeAirport, persona, features,
});

export const SEED_TRAVELERS = [
  t('EXP-100231', 'Maya', 'Chen', 'Gold', 'SEA', 'Frequent business traveler, inbox saturated',
    { sends7d: 7, sends30d: 24, openRate30d: 0.09, clickRate30d: 0.01, daysSinceLastEngaged: 19, unsubPageViews30d: 1, daysToNextTrip: 62, lifetimeBookings: 41 }),
  t('EXP-100232', 'Jordan', 'Alvarez', 'Blue', 'AUS', 'New One Key member, highly engaged',
    { sends7d: 1, sends30d: 4, openRate30d: 0.52, clickRate30d: 0.11, daysSinceLastEngaged: 1, unsubPageViews30d: 0, daysToNextTrip: null, lifetimeBookings: 1 }),
  t('EXP-100233', 'Priya', 'Nair', 'Platinum', 'JFK', 'Luxury family vacationer, trip in 9 days',
    { sends7d: 5, sends30d: 17, openRate30d: 0.31, clickRate30d: 0.05, daysSinceLastEngaged: 3, unsubPageViews30d: 0, daysToNextTrip: 9, lifetimeBookings: 28 }),
  t('EXP-100234', 'Sam', "O'Connor", 'Silver', 'ORD', 'Deal seeker, showing fatigue',
    { sends7d: 6, sends30d: 21, openRate30d: 0.12, clickRate30d: 0.02, daysSinceLastEngaged: 14, unsubPageViews30d: 2, daysToNextTrip: null, lifetimeBookings: 9 }),
  t('EXP-100235', 'Lena', 'Fischer', 'Blue', 'DEN', 'Dormant — last booked 14 months ago',
    { sends7d: 2, sends30d: 9, openRate30d: 0.04, clickRate30d: 0.0, daysSinceLastEngaged: 58, unsubPageViews30d: 0, daysToNextTrip: null, lifetimeBookings: 3 }),
  t('EXP-100236', 'Marcus', 'Reed', 'Gold', 'ATL', 'Weekend getaway regular',
    { sends7d: 3, sends30d: 11, openRate30d: 0.27, clickRate30d: 0.06, daysSinceLastEngaged: 4, unsubPageViews30d: 0, daysToNextTrip: 18, lifetimeBookings: 16 }),
  t('EXP-100237', 'Aiko', 'Tanaka', 'Silver', 'SFO', 'Borderline — hovering near threshold',
    { sends7d: 5, sends30d: 16, openRate30d: 0.17, clickRate30d: 0.03, daysSinceLastEngaged: 9, unsubPageViews30d: 0, daysToNextTrip: null, lifetimeBookings: 7 }),
  t('EXP-100238', 'Diego', 'Ramos', 'Blue', 'MIA', 'Cruise browser, moderate engagement',
    { sends7d: 2, sends30d: 8, openRate30d: 0.22, clickRate30d: 0.04, daysSinceLastEngaged: 6, unsubPageViews30d: 0, daysToNextTrip: null, lifetimeBookings: 4 }),
];
