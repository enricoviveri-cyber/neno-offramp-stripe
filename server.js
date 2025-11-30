require('dotenv').config();
const express = require('express');
const { Web3 } = require('web3');
const axios = require('axios');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// ==================== CONFIGURAZIONE ====================
const NENO_ADDRESS = '0xeF3F5C1892A8d7A3304E4A15959E124402d69974';
const SERVICE_WALLET = process.env.SERVICE_WALLET_ADDRESS?.trim();

console.log(`NENO Off-Ramp LIVE (PREZZO FISSO 1.000€ per NENO)`);
console.log(`Wallet ricezione: \( {SERVICE_WALLET?.slice(0,6)}... \){SERVICE_WALLET?.slice(-4)}`);

// ==================== PREZZO FISSO 1000€ PER 1 NENO ====================
const NENO_PRICE_EUR = 1000.00;  // ← PREZZO FISSO UFFICIALE

// ==================== CREA SESSIONE CHECKOUT (1000€ per NENO) ====================
app.post('/create-session', async (req, res) => {
  const { tokenAmount } = req.body;
  const amount = parseFloat(tokenAmount);

  if (!amount || amount < 1) {
    return res.status(400).json({ error: "Minimo 1 NENO" });
  }

  const eurNet = (amount * NENO_PRICE_EUR * 0.975).toFixed(2);  // 2.5% fee per te
  const eurGross = (amount * NENO_PRICE_EUR).toFixed(2);

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: { 
            name: `Acquisto ${amount.toFixed(4)} NENO a 1.000€/NENO` 
          },
          unit_amount: Math.round(eurNet * 100),
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${req.headers.origin || 'https://' + req.headers.host}/success.html`,
      cancel_url: `${req.headers.origin || 'https://' + req.headers.host}/cancel.html`,
      metadata: {
        neno_amount: amount.toString(),
        neno_price_per_token: "1000",
        eur_total: eurGross,
        type: 'neno_offramp_fixed_1000'
      }
    });

    res.json({
      success: true,
      walletAddress: SERVICE_WALLET,
      amountNENO: amount,
      eurAmount: eurNet,
      eurGross: eurGross,
      pricePerNENO: "1.000,00 €",
      fee: "2.5%",
      paymentUrl: session.url,
      message: `Invia esattamente ${amount.toFixed(4)} NENO dopo il pagamento`
    });
  } catch (err) {
    console.error('Errore Stripe:', err.message);
    res.status(500).json({ error: 'Errore pagamento – riprova o contatta supporto' });
  }
});

// ==================== WEBHOOK ALCHEMY (listener reale) ====================
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
        console.log(`NENO RICEVUTI (1.000€/NENO)!`);
        console.log(`   ${amount.toFixed(4)} NENO`);
        console.log(`   Valore: €${(amount * 1000).toFixed(2)}`);
        console.log(`   Da: ${tx.from}`);
        console.log(`   Tx: https://bscscan.com/tx/${tx.hash}`);
      }
    }
  }

  res.json({ success: true });
});

// ==================== ROOT ====================
app.get('/', (req, res) => {
  res.send(`
    <h1 style="text-align:center; padding:100px; font-family:sans-serif;">
      NENO Off-Ramp LIVE<br>
      Prezzo fisso: <strong>1.000 € per NENO</strong><br><br>
      <a href="/index.html">Vendi NENO ora</a>
    </h1>
  `);
});

// ==================== AVVIO ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`NENO OFF-RAMP 1.000€/NENO ATTIVO`);
  console.log(`URL: https://${process.env.RENDER_EXTERNAL_HOSTNAME || 'localhost:' + PORT}`);
  console.log(`Wallet: ${SERVICE_WALLET}`);
});
