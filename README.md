# NexusWarmup v2 — Synthetic Identity Engine

Build Google account demographic profiles for GA4 demographic signals.

## How it works

10 Google accounts × 22 days = 10 identities dengan verified interest profile.

Setelah 22 hari, akun digunakan oleh NexusPlaywright untuk inject demographic signal ke GA4 target website.

## Deploy

```bash
npm install
npx playwright install chromium --with-deps
cp .env.example .env
pm2 start src/server.js --name nexus-warmup
```

## Phase System

| Day | Phase | Activities |
|-----|-------|-----------|
| 1-3 | login_only | Browse news, visit sites |
| 4-7 | light | 2-3 Google searches + YouTube |
| 8-14 | medium | Niche searches + site visits + YouTube |
| 15-21 | deep | Full simulation + Reddit |
| 22+ | ready | Ready for GA4 demographic injection |

## Trust Score

- 🔴 < 40: Building
- 🟡 40-75: Warming  
- 🟢 > 75: Ready for GA4 demographic injection

## Personas

- fashion_female_25 → Female 25-34, Fashion & Beauty
- finance_male_35 → Male 35-44, Finance & Investing
- tech_male_28 → Male 25-34, Technology
- health_female_40 → Female 35-44, Health & Fitness
- travel_female_30 → Female 25-34, Travel & Adventure
