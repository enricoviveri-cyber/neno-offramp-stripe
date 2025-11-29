# NENO Off-Ramp Stripe → 100% automatico (28 nov 2025)

Off-ramp istantaneo NENO (BEP-20) → Euro sul conto bancario dell'utente

### Funzionalità complete
- Listener blockchain real-time
- Verifica automatica trasferimento
- Payout automatico via Stripe Connect + Transfers
- Gestione KYC/AML (Stripe Connect)
- Coda Redis per payout sicuri
- Deploy gratis su Render (web + worker + redis)

### Deploy su Render (2 minuti)
1. Crea repo GitHub con tutti i file sopra
2. Vai su https://dashboard.render.com
3. New → Web Service → connetti repo
4. Render rileva automaticamente `render.yaml` → crea web + worker + Redis
5. Aggiungi variabili d'ambiente:
   - `PRIVATE_KEY`
   - `STRIPE_SECRET_KEY`
   - `STRIPE_WEBHOOK_SECRET`
   - `REDIS_URL` (Render lo crea automaticamente)

Live in 90 secondi.
