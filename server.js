require('dotenv').config();
const express = require('express');
const { Web3 } = require('web3');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

const NENO_ADDRESS = '0xeF3F5C1892A8d7A3304E4A15959E124402d69974';
const SERVICE_WALLET = process.env.SERVICE_WALLET_ADDRESS?.trim();
const NENO_PRICE_EUR = 1000.00;        // 1 NENO = 1.000 €
const MAX_NENO_PER_TX = 500;           // ← LIMITE MASSIMO (500.000 € netti)

console.log(`NENO Off-Ramp LIVE – 1.000€/NENO – Max ${MAX_NENO_PER_TX} NENO per transazione`);

app.post('/create-session', async (req, res) => {
  const { tokenAmount } = req.body;
  const amount = parseFloat(tokenAmount);

  if (!amount || amount < 1) {
    return res.status(400).json({ error: "Minimo 1 NENO" });
  }
  if (amount > MAX_NENO_PER_TX) {
    return res.status(400).json({ 
      error: `Massimo ${MAX_NENO_PER_TX} NENO per transazione (500.000 € netti)` 
    });
  }

  const eurGross = (amount * NENO_PRICE_EUR).toFixed(2);
  const eurNet   = (amount * NENO_PRICE_EUR * 0.975).toFixed(2); // 2.5% fee

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: { name: `${amount.toFixed(4)} NENO × 1.000€` },
          unit_amount: Math.round(eurNet * 100),
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${req.headers.origin || 'https://' + req.headers.host}/success.html`,
      cancel_url:  `${req.headers.origin || 'https://' + req.headers.host}/cancel.html`,
      metadata: {
        neno_amount: amount.toString(),
        price_per_neno: "1000",
        eur_net: eurNet,
        type: 'neno_offramp_1000'
      }
    });

    res.json({
      success: true,
      walletAddress: SERVICE_WALLET,
      amountNENO: amount,
      eurNet: eurNet,
      eurGross: eurGross,
      pricePerNENO: "1.000 €",
      fee: "2.5%",
      paymentUrl: session.url,
      message: `Invia ${amount.toFixed(4)} NENO dopo il pagamento`
    });
  } catch (err) {
    console.error('Stripe error:', err.message);
    res.status(500).json({ error: 'Pagamento rifiutato – importo troppo alto o carta non valida' });
  }
});

// Webhook Alchemy (invariato – funziona)
app.post('/webhook/alchemy', express.raw({ type: 'application/json' }), (req, res) => {
  let payload;
  try { payload = JSON.parse(req.body); } catch { return res.status(400).send('Bad JSON'); }

  if (payload.type === 'MINED_TRANSACTION' || payload.event?.data?.block) {
    const txs = payload.event?.data?.block?.transactions || payload.transactions || [];
    for (const tx of txs) {
      if (!tx.input?.startsWith('0xa9059cbb')) continue;
      if (tx.to?.toLowerCase() !== NENO_ADDRESS.toLowerCase()) continue;

      const to = '0x' + tx.input.slice(34, 74);
      const value = BigInt('0x' + tx.input.slice(74));
      const amount = Number(value) / 1e18;

      if (to.toLowerCase() === SERVICE_WALLET.toLowerCase() && amount >= 1) {
        console.log(`NENO RICEVUTI – Valore €${(amount*1000).toLocaleString('it-IT')} !`);
        console.log(`   \( {amount.toFixed(4)} NENO da \){tx.from}`);
        console.log(`   Tx https://bscscan.com/tx/${tx.hash}`);
      }
    }
  }
  res.json({ success: true });
});

app.get('/', (req, res) => res.sendFile(__dirname + '/public/index.html'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`OFF-RAMP 1.000€/NENO ATTIVO – max ${MAX_NENO_PER_TX} per tx`);
});
