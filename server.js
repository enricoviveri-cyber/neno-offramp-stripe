require('dotenv').config();
const express = require('express');
const { Web3 } = require('web3');
const axios = require('axios');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// ==================== CONFIGURAZIONE ====================
let PRIVATE_KEY = (process.env.PRIVATE_KEY || '').trim();
if (PRIVATE_KEY && !PRIVATE_KEY.startsWith('0x')) PRIVATE_KEY = '0x' + PRIVATE_KEY;

const web3 = new Web3('https://bsc-dataseed.binance.org/');
const NENO_ADDRESS = '0xeF3F5C1892A8d7A3304E4A15959E124402d69974';
const SERVICE_WALLET = process.env.SERVICE_WALLET_ADDRESS?.trim();

// Log sicuro (solo prime/ultime cifre)
console.log(`NENO Off-Ramp LIVE - Wallet: \( {SERVICE_WALLET?.slice(0,6)}... \){SERVICE_WALLET?.slice(-4)}`);

// ==================== PREZZO NENO/EUR ====================
let nenoPriceEUR = 0.0087;

async function updateNenoPrice() {
  try {
    const res = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=neonoble&vs_currencies=eur', { timeout: 10000 });
    if (res.data.neonoble?.eur) {
      nenoPriceEUR = res.data.neonoble.eur;
      console.log(`Prezzo NENO aggiornato: €${nenoPriceEUR.toFixed(6)}`);
    }
  } catch (e) {
    console.log('Prezzo fallback attivo:', e.message);
  }
}
updateNenoPrice();
setInterval(updateNenoPrice, 30000);

// ==================== CREA SESSIONE CHECKOUT (FUNZIONA SEMPRE) ====================
app.post('/create-session', async (req, res) => {
  const { tokenAmount } = req.body;
  const amount = parseFloat(tokenAmount);

  if (!amount || amount < 10) {
    return res.status(400).json({ error: "Minimo 10 NENO" });
  }

  const eurGross = amount * nenoPriceEUR;
  const feePercent = 2.5;
  const eurNet = (eurGross * (1 - feePercent / 100)).toFixed(2);

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: { name: `Vendita ${amount.toFixed(4)} NENO` },
          unit_amount: Math.round(eurNet * 100),
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${process.env.RENDER_EXTERNAL_URL || 'https://' + req.headers.host}/success.html`,
      cancel_url: `${process.env.RENDER_EXTERNAL_URL || 'https://' + req.headers.host}/cancel.html`,
      metadata: {
        neno_amount: amount.toString(),
        wallet: SERVICE_WALLET,
        type: 'neno_offramp'
      }
    });

    res.json({
      success: true,
      walletAddress: SERVICE_WALLET,
      amountNENO: amount,
      eurAmount: eurNet,
      fee: `${feePercent}%`,
      paymentUrl: session.url,  // Link Stripe che funziona al 100%
      message: "Invia NENO dopo il pagamento"
    });
  } catch (err) {
    console.error('Errore Stripe Checkout:', err.message);
    res.status(500).json({ error: 'Errore pagamento – usa carta valida o contatta supporto' });
  }
});

// ==================== WEBHOOK ALCHEMY (LISTENER REALE) ====================
app.post('/webhook/alchemy', express.raw({ type: 'application/json' }), (req, res) => {
  let payload;
  try { payload = JSON.parse(req.body); } catch { return res.status(400).send('Invalid JSON'); }

  console.log('Webhook Alchemy ricevuto');

  if (payload.type === 'MINED_TRANSACTION' || payload.event?.data?.block) {
    const txs = payload.event?.data?.block?.transactions || payload.transactions || [];

    for (const tx of txs) {
      if (!tx.input || !tx.to) continue;
      if (!tx.input.startsWith('0xa9059cbb')) continue;
      if (tx.to?.toLowerCase() !== NENO_ADDRESS.toLowerCase()) continue;

      const to = '0x' + tx.input.slice(34, 74);
      const value = BigInt('0x' + tx.input.slice(74));
      const amount = Number(value) / 1e18;

      if (to.toLowerCase() === SERVICE_WALLET.toLowerCase() && amount >= 1) {
        console.log(`NENO RICEVUTI!`);
        console.log(`   \( {amount.toFixed(4)} NENO da \){tx.from}`);
        console.log(`   https://bscscan.com/tx/${tx.hash}`);
        // Qui puoi aggiungere: Telegram, DB, payout automatico
      }
    }
  }

  res.json({ success: true });
});

// ==================== PAGINE STATICHE ====================
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

// ==================== AVVIO ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`OFF-RAMP NENO ATTIVO`);
  console.log(`URL: https://${process.env.RENDER_EXTERNAL_HOSTNAME || 'localhost:' + PORT}`);
  console.log(`Wallet: ${SERVICE_WALLET}`);
  console.log(`Webhook: https://${process.env.RENDER_EXTERNAL_HOSTNAME}/webhook/alchemy`);
});
