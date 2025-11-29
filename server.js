require('dotenv').config();
const express = require('express');
const { Web3 } = require('web3');  // FIX PER V4.X: destrutturare Web3
const axios = require('axios');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// ==================== CONFIGURAZIONE WALLET ====================
let PRIVATE_KEY = (process.env.PRIVATE_KEY || '').trim();
if (PRIVATE_KEY && !PRIVATE_KEY.startsWith('0x')) PRIVATE_KEY = '0x' + PRIVATE_KEY;

const web3 = new Web3('https://bsc-dataseed.binance.org/');  // FIX: new Web3() con import corretto
const NENO_ADDRESS = '0xeF3F5C1892A8d7A3304E4A15959E124402d69974';
const SERVICE_WALLET = process.env.SERVICE_WALLET_ADDRESS?.trim() || '0xInserisciQuiIlTuoWalletBSC';

// Per sicurezza: logga solo parziale indirizzo
console.log(`NENO Off-Ramp avviato - Wallet ricezione: \( {SERVICE_WALLET.slice(0, 6)}... \){SERVICE_WALLET.slice(-4)}`);

// ==================== PREZZO NENO/EUR (LIVE UPDATE) ====================
let nenoPriceEUR = 0.0087; // fallback

async function updateNenoPrice() {
  try {
    const res = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=neonoble&vs_currencies=eur', { timeout: 10000 });
    if (res.data.neonoble?.eur) {
      nenoPriceEUR = res.data.neonoble.eur;
      console.log(`Prezzo NENO aggiornato: €${nenoPriceEUR.toFixed(5)}`);
    }
  } catch (e) {
    console.log('Prezzo NENO non aggiornato (uso fallback):', e.message);
  }
}
updateNenoPrice();  // Prima chiamata
setInterval(updateNenoPrice, 30000);  // Ogni 30 secondi

// ==================== ENDPOINT CREA SESSIONE OFF-RAMP ====================
app.post('/create-session', async (req, res) => {
  const { tokenAmount } = req.body;
  const amount = parseFloat(tokenAmount);

  if (!amount || amount < 10) {
    return res.status(400).json({ error: "Importo minimo: 10 NENO" });
  }

  const eurGross = amount * nenoPriceEUR;
  const feePercent = 2.5;
  const eurNet = (eurGross * (1 - feePercent / 100)).toFixed(2);

  try {
    const paymentLink = await stripe.paymentLinks.create({
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: { name: `Vendita ${amount.toFixed(4)} NENO` },
          unit_amount: Math.round(eurNet * 100),
        },
        quantity: 1,
      }],
      metadata: {
        neno_amount: amount.toString(),
        wallet: SERVICE_WALLET,
        type: 'neno_offramp'
      },
      after_completion: { type: 'redirect', redirect: { url: 'https://yourdomain.com/thanks' } }
    });

    console.log(`Nuova sessione creata: \( {amount} NENO → € \){eurNet}`);
    res.json({
      success: true,
      walletAddress: SERVICE_WALLET,
      amountNENO: amount,
      eurAmount: eurNet,
      fee: `${feePercent}%`,
      paymentUrl: paymentLink.url,
      message: `Invia esattamente ${amount} NENO a questo indirizzo BSC (monitoraggio automatico attivo)`
    });
  } catch (err) {
    console.error('Errore Stripe:', err.message);
    res.status(500).json({ error: 'Errore creazione pagamento' });
  }
});

// ==================== WEBHOOK ALCHEMY INTEGRATO (LISTENER REALE IN TEMPO REALE) ====================
app.post('/webhook/alchemy', express.raw({ type: 'application/json' }), (req, res) => {
  let payload;
  try {
    payload = JSON.parse(req.body.toString());
    console.log('Webhook Alchemy ricevuto:', payload.type || 'sconosciuto');
  } catch (e) {
    console.error('Payload Alchemy non valido:', e.message);
    return res.status(400).send('Invalid JSON');
  }

  if (payload.type === 'MINED_TRANSACTION' || payload.event?.data?.block) {
    const txs = payload.event?.data?.block?.transactions || payload.transactions || [];
    
    for (const tx of txs) {
      if (!tx.input || !tx.to) continue;

      // Verifica trasferimento ERC-20/BEP-20 (metodo transfer: 0xa9059cbb)
      if (tx.input.startsWith('0xa9059cbb') && tx.to?.toLowerCase() === NENO_ADDRESS.toLowerCase()) {
        const to = '0x' + tx.input.slice(34, 74);
        const valueHex = '0x' + tx.input.slice(74);
        const value = BigInt(valueHex);
        const amount = Number(value) / 1e18;  // Decimale NENO (18)

        if (
          to.toLowerCase() === SERVICE_WALLET.toLowerCase() &&
          amount >= 1
        ) {
          console.log(`✅ NENO RICEVUTI IN TEMPO REALE!`);
          console.log(`   Importo: ${amount.toFixed(4)} NENO`);
          console.log(`   Da: ${tx.from}`);
          console.log(`   Tx: https://bscscan.com/tx/${tx.hash}`);
          // QUI AGGIUNGI: notifica Telegram, salva in DB, attiva payout Stripe, ecc.
          // Esempio: await sendTelegram(`NENO ricevuti: ${amount}`);
        }
      }
    }
  }

  res.json({ success: true });
});

// ==================== ROOT PAGE (TEST / DASHBOARD SEMPLICE) ====================
app.get('/', (req, res) => {
  res.send(`
    <h1>🚀 NENO Off-Ramp LIVE (29 Nov 2025)</h1>
    <p><strong>Wallet ricezione:</strong> <code>${SERVICE_WALLET}</code></p>
    <p><strong>Prezzo attuale:</strong> 1 NENO = €${nenoPriceEUR.toFixed(5)}</p>
    <p><a href="/index.html">Vai al form di vendita NENO → Euro</a></p>
    <p><small>Webhook Alchemy: <code>https://${req.get('host')}/webhook/alchemy</code></small></p>
  `);
});

// ==================== AVVIO SERVER ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 NENO OFF-RAMP ATTIVO su porta ${PORT}`);
  console.log(`📱 URL: https://${process.env.RENDER_EXTERNAL_HOSTNAME || 'your-service.onrender.com'}`);
  console.log(`💰 Wallet: \( {SERVICE_WALLET.slice(0, 6)}... \){SERVICE_WALLET.slice(-4)}`);
  console.log(`🔗 Webhook Alchemy pronto: https://${process.env.RENDER_EXTERNAL_HOSTNAME || 'your-service.onrender.com'}/webhook/alchemy`);
  console.log(`💚 Listener token attivi - Invia NENO e vedi in console!`);
});
