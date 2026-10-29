# 🏎️ DOWNFORCE — 2026 Formula 1 Fantasy & Prediction League

A real-time Formula 1 prediction league and race-weekend telemetry platform built with **TanStack Start**, **React 19**, **Tailwind CSS v4**, and **Supabase**.

##  Key Features

- **Grand Prix & Sprint Predictions**: Drag-and-drop Top 10 race finish order, Pole Position (Q3), Fastest Lap, DNF pick, and Sprint Top 8 grid with automatic server-enforced lock deadlines.
- **Official 2026 F1 Standings & Live Telemetry**: Instant 0ms initial snapshot backed by live Jolpica-F1 (Ergast) & OpenF1 synchronization.
- **Head-to-Head (H2H) & Paddock Analytics**: Compare player accuracy, round-by-round breakdowns, and shareable social result cards.
- **Native Web Push Alerts (RFC 8292 / AES-128-GCM)**: Automated 2-hour and 30-minute lock reminders with strict server-only VAPID key isolation.
- **FIA Stewards & Race Control**: Dedicated race-director dashboard for deadline management, manual result overrides, JSON backups, and live pick radar.

##  Running Locally (PowerShell)

1. **Clone the repository**:
   ```powershell
   git clone https://github.com/mohamdy74/Downforce-f1-fantasy.git
   cd Downforce-f1-fantasy
   ```

2. **Install dependencies**:
   ```powershell
   npm install
   ```

3. **Configure `.env`**:
   The committed `.env` already holds the public, build-time values (Supabase URL + publishable key, VAPID public key). For local development, add your secrets **locally only — never commit them**:
   ```ini
   SUPABASE_SERVICE_ROLE_KEY="your-service-role-key"   # local only
   VAPID_PRIVATE_KEY="your-vapid-private-key"          # local only
   ```
   In production, secrets live in Lovable Secrets — never in this repository.

4. **Start the development server**:
   ```powershell
   npm run dev
   ```
   Open [http://localhost:3000](http://localhost:3000) in your browser.
