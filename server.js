require('dotenv').config();
const express = require('express');
const { Web3 } = require('web3');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// ==================== CONFIGURAZIONE ====================
const NENO_ADDRESS = '0xeF3F5C1892A8d7A3304E4A15959E124402d69974';
const SERVICE_WALLET = process.env.SERVICE_WALLET_ADDRESS?.trim();
const NENO_PRICE_EUR = 1000.00;           // 1 NENO = 1.000 €
const MAX_NENO_PER_TX = 100;              // ← LIMITE SICURO (97.500 € netti)

console.log(`NENO OFF-RAMP ATTIVO`);
console.log(`Prezzo: 1 NENO = 1.000 € | Max ${MAX_NENO_PER_TX} NENO per transazione`);
console.log(`Wallet ricezione: \( {SERVICE_WALLET?.slice(0,6)}... \){SERVICE_WALLET?.slice(-4)}`);

// ==================== CREA SESSIONE DI PAGAMENTO ====================
app.post('/create-session', async (req, res) => {
  const { tokenAmount } = req.body;
  const amount = parseFloat(tokenAmount);

  if (!amount || amount < 1) {
    return res.status(400).json({ error: "Inserisci almeno 1 NENO" });
  }
  if (amount > MAX_NENO_PER_TX) {
    return res.status(400).json({ 
      error: `Massimo ${MAX_NENO_PER_TX} NENO per transazione (97.500 € netti)` 
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
          product_data: { 
            name: `${amount.toFixed(4)} NENO × 1.000€ cadauno` 
          },
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
        eur_gross: eurGross,
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
      message: `Invia esattamente ${amount.toFixed(4)} NENO dopo aver completato il pagamento`
    });

  } catch (err) {
    console.error('Errore Stripe:', err.message);
    res.status(500).json({ 
      error: 'Pagamento non autorizzato – usa un\'altra carta o riduci l\'importo' 
    });
  }
});

// ==================== WEBHOOK ALCHEMY ====================
app.post('/webhook/alchemy', express.raw({ type: 'application/json' }), (req, res) => {
  let payload;
  try { payload = JSON.parse(req.body); } catch { return res.status(400).send('Bad JSON'); }

  console.log('Webhook Alchemy ricevuto');

  if (payload.type === 'MINED_TRANSACTION' || payload.event?.data?.block) {
    const txs = payload.event?.data?.block?.transactions || payload.transactions || [];

    for (const tx of txs) {
      if (!tx.input?.startsWith('0xa9059cbb')) continue;
      if (tx.to?.toLowerCase() !== NENO_ADDRESS.toLowerCase()) continue;

      const to = '0x' + tx.input.slice(34, 74);
      const value = BigInt('0x' + tx.input.slice(74));
      const amount = Number(value) / 1e18;

      if (to.toLowerCase() === SERVICE_WALLET.toLowerCase() && amount >= 1) {
        console.log(`NENO RICEVUTI!`);
        console.log(`   Importo: ${amount.toFixed(4)} NENO`);
        console.log(`   Valore: €${(amount * 1000).toLocaleString('it-IT')}`);
        console.log(`   Da: ${tx.from}`);
        console.log(`   Tx: https://bscscan.com/tx/${tx.hash}`);
        // Qui puoi aggiungere Telegram, email, ecc.
      }
    }
  }
  res.json({ success: true });
});

// ==================== ROOT ====================
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

// ==================== AVVIO SERVER ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`OFF-RAMP NENO 1.000€ ATTIVO`);
  console.log(`URL: https://${process.env.RENDER_EXTERNAL_HOSTNAME || 'localhost:' + PORT}`);
  console.log(`Massimo ${MAX_NENO_PER_TX} NENO per transazione`);
});
