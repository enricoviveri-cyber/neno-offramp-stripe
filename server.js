require('dotenv').config();
const express = require('express');
const { Web3 } = require('web3');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

const NENO_ADDRESS = '0xeF3F5C1892A8d7A3304E4A15959E124402d69974';
const SERVICE_WALLET = process.env.SERVICE_WALLET_ADDRESS?.trim();
const NENO_PRICE_EUR = 1000.00;
const MAX_NENO_PER_TX = 30;                    // ← 30 NENO = 29.250 € netti → PASSA SEMPRE

console.log(`NENO OFF-RAMP – 1.000€/NENO – MAX ${MAX_NENO_PER_TX} NENO per transazione`);

app.post('/create-session', async (req, res) => {
  const { tokenAmount } = req.body;
  const amount = parseFloat(tokenAmount);

  if (!amount || amount < 1) return res.status(400).json({ error: "Minimo 1 NENO" });
  if (amount > MAX_NENO_PER_TX) {
    return res.status(400).json({ 
      error: `Massimo ${MAX_NENO_PER_TX} NENO per transazione (29.250 € netti)` 
    });
  }

  const eurGross = (amount * 1000).toFixed(2);
  const eurNet   = (amount * 1000 * 0.975).toFixed(2);   // 2.5% fee

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
      metadata: { neno_amount: amount.toString(), price: "1000" }
    });

    res.json({
      success: true,
      walletAddress: SERVICE_WALLET,
      amountNENO: amount,
      eurNet,
      eurGross,
      pricePerNENO: "1.000 €",
      fee: "2.5%",
      paymentUrl: session.url
    });

  } catch (err) {
    console.error('Stripe error:', err.message);
    res.status(500).json({ error: 'Pagamento non autorizzato – prova con importo ≤ 30 NENO' });
  }
});

// Webhook Alchemy (invariato)
app.post('/webhook/alchemy', express.raw({ type: 'application/json' }), (req, res) => {
  let payload;
  try { payload = JSON.parse(req.body); } catch { return res.status(400).send('Bad JSON'); }
  // ... (stesso codice di prima)
  res.json({ success: true });
});

app.get('/', (req, res) => res.sendFile(__dirname + '/public/index.html'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`OFF-RAMP ATTIVO – max ${MAX_NENO_PER_TX} NENO`));
