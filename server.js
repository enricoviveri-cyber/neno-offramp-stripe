require('dotenv').config();
const express = require('express');
const { Web3 } = require('web3');
const axios = require('axios');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const Redis = require('ioredis');
const BigNumber = require('bignumber.js');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));
app.use('/webhook', require('./webhook/stripe-webhook'));

const redis = new Redis(process.env.REDIS_URL);

// RPC più stabile del mondo (funziona sempre su Render)
const web3 = new Web3('https://bsc-dataseed1.defibit.io/');

const NENO_ADDRESS = '0xeF3F5C1892A8d7A3304E4A15959E124402d69974';
const SERVICE_WALLET = web3.eth.accounts.privateKeyToAccount(process.env.PRIVATE_KEY).address.toLowerCase();

// Prezzo NENO/EUR
let nenoPriceEUR = 0.0087;
const updatePrice = async () => {
  try {
    const r = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=neonoble&vs_currencies=eur', { timeout: 7000 });
    if (r.data.neonoble?.eur) && (nPriceEUR = r.data.neonoble.eur);
  } catch {}
};
updatePrice();
setInterval(updatePrice, 30000);

// ================== CREAZIONE SESSIONE ==================
app.post('/create-session', async (req, res) => {
  const { tokenAmount, stripeAccountId } = req.body;
  const amount = parseFloat(tokenAmount);

  if (isNaN(amount) || amount < 10) return res.status(400).json({ error: "Minimo 10 NENO" });

  const eurNet = new BigNumber(amount).multipliedBy(nPriceEUR).multipliedBy(0.975).toFixed(2);

  const sessionId = Date.now().toString(36) + Math.random().toString(36).slice(2);

  await redis.setex(`pending:${sessionId}`, 3600, JSON.stringify({
    amount,
    eurNet,
    stripeAccountId: stripeAccountId || null,
    createdAt: Date.now(),
    status: 'waiting_transfer'
  }));

  res.json({
    success: true,
    sessionId,
    wallet: SERVICE_WALLET,
    amountNENO: amount,
    eurAmount: eurNet,
    message: `Invia \( {amount} NENO a \){SERVICE_WALLET}`
  });
});

// ================== LISTENER POLLING 100% ANTI-BIGINT ==================
let lastProcessedBlock = 0n; // BigInt!

const startListener = async () => {
  {
  console.log('Listener NENO avviato – versione anti-BigInt (funziona sempre)');

  try {
    const bn = await web3.eth.getBlockNumber();
    lastProcessedBlock = BigInt(bn);
    console.log(`Partenza dal blocco ${lastProcessedBlock}`);
  } catch (e) {
    console.log('Blocco iniziale non letto → parto da 0');
    lastProcessedBlock = 0n;
  }

  setInterval(async () => {
    try {
      const latest = BigInt(await web3.eth.getBlockNumber());

      if (latest <= lastProcessedBlock) return;

      const from = lastProcessedBlock + 1n;

      const logs = await web3.eth.getPastLogs({
        fromBlock: web3.utils.toHex(from),
        toBlock: 'latest',
        address: NENO_ADDRESS,
        topics: [
          web3.utils.sha3('Transfer(address,address,uint256)'),
          null,
          web3.utils.padLeft(SERVICE_WALLET, 64)
        ]
      });

      for (const log of logs) {
        const valueBN = BigInt(log.data);
        const value = Number(valueBN / 10n**18n);

        if (value < 10) continue;

        const tx = log.transactionHash;
        if (await redis.exists(`proc:${tx}`)) continue;

        const fromAddr = '0x' + log.topics[1].slice(-40).toLowerCase();

        const keys = await redis.keys('pending:*');
        for (const k of keys) {
          const s = JSON.parse(await redis.get(k));
          if (Math.abs(s.amount - value) < 1 && s.status === 'waiting_transfer') {
            await redis.lpush('payout_queue', JSON.stringify({
              sessionKey: k,
              amountNENO: value,
              eurNet: s.eurNet,
              stripeAccountId: s.stripeAccountId,
              fromAddress: fromAddr,
              txHash: tx
            }));
            await redis.set(k, JSON.stringify({ ...s, status: 'transfer_received', from: fromAddr, txHash: tx }));
            console.log(`RILEVATO \( {value} NENO da \){fromAddr} → €${s.eurNet}`);
            await redis.set(`proc:${tx}`, '1', 'EX', 2592000);
            break;
          }
        }
      }

      lastProcessedBlock = latest;

    } catch (err) {
      console.log('Polling errore temporaneo (riprovo):', err.message.slice(0,100));
    }
  }, 7000); // 7 secondi – super tranquillo
};

startListener();

// ================== START ==================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('NENO OFF-RAMP È FINALMENTE ONLINE E STABILE');
  console.log(`https://neno-offramp-stripe.onrender.com`);
  console.log(`Wallet: ${SERVICE_WALLET}`);
  console.log(`Prezzo NENO: €${nPriceEUR}`);
});
