require('dotenv').config();
const express = require('express');
const Web3 = require('web3');
const axios = require('axios');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const bodyParser = require('body-parser');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));
app.use('/webhook/alchemy', require('./webhook/alchemy-webhook'));

// Fix private key
let PRIVATE_KEY = process.env.PRIVATE_KEY?.trim();
if (PRIVATE_KEY && !PRIVATE_KEY.startsWith('0x')) PRIVATE_KEY = '0x' + PRIVATE_KEY;

const web3 = new Web3('https://bsc-dataseed.binance.org/');
const NENO_ADDRESS = '0xeF3F5C1892A8d7A3304E4A15959E124402d69974';
const SERVICE_WALLET = process.env.SERVICE_WALLET_ADDRESS || '0x...';

let nenoPriceEUR = 0.0087;
async function updatePrice() {
  try {
    const res = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=neonoble&vs_currencies=eur');
    nenoPriceEUR = res.data.neonoble?.eur || 0.0087;
  } catch (e) {}
}
updatePrice();
setInterval(updatePrice, 30000);

// Database in memoria (per demo)
const pendingTxs = new Map(); // txHash → { amount, userWallet, eur }

// Endpoint principale
app.post('/create-session', async (req, res) => {
  const { tokenAmount } = req.body;
  const amount = parseFloat(tokenAmount);
  if (!amount || amount < 10) return res.status(400).json({ error: "Minimo 10 NENO" });

  const eurNet = (amount * nenoPriceEUR * 0.975).toFixed(2); // 2.5% fee

  try {
    const session = await stripe.paymentLinks.create({
      line_items: [{ price_data: { currency: 'eur', product_data: { name: `Vendita ${amount} NENO` }, unit_amount: Math.round(eurNet * 100) }, quantity: 1 }],
      metadata: { neno_amount: amount.toString(), type: 'offramp' },
      after_completion: { type: 'redirect', redirect: { url: 'https://yourdomain.com/thanks' }}
    });

    res.json({
      success: true,
      walletAddress: SERVICE_WALLET,
      amountNENO: amount,
      eurAmount: eurNet,
      fee: "2.5%",
      paymentUrl: session.url,
      message: "Invia NENO → verrai pagato automaticamente entro 24h"
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ricevi notifiche Alchemy in tempo reale
app.post('/webhook/alchemy', bodyParser.raw({type: 'application/json'}), (req, res) => {
  const data = JSON.parse(req.body);
  
  if (data.type === 'MINED_TRANSACTION') {
    for (const tx of data.event.data.block.transactions) {
      if (tx.to?.toLowerCase() === NENO_ADDRESS.toLowerCase() || tx.to === null) continue;
      
      // Decodifica trasferimento ERC-20
      const input = tx.input;
      if (input.startsWith('0xa9059cbb') && tx.to?.toLowerCase() === SERVICE_WALLET.toLowerCase()) {
        const to = '0x' + input.slice(34, 74);
        const value = BigInt('0x' + input.slice(74));
        const amount = Number(value) / 1e18;

        if (to.toLowerCase() === SERVICE_WALLET.toLowerCase() && amount >= 10) {
          console.log(`RICEVUTI \( {amount} NENO da \){tx.from}!`);
          // Qui puoi notificare Telegram, salvare in DB, ecc.
          // In futuro: payout automatico con Stripe Connect
        }
      }
    }
  }
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`NENO Off-Ramp LIVE → https://your-service.onrender.com`);
  console.log(`Wallet: ${SERVICE_WALLET}`);
  console.log(`Webhook Alchemy: ${process.env.ALCHEMY_WEBHOOK_URL}/webhook/alchemy`);
});
