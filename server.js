require('dotenv').config();
const express = require('express');
const { Web3 } = require('web3');           // ← Web3 v4 corretto
const axios = require('axios');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const Redis = require('ioredis');
const BigNumber = require('bignumber.js');

// ================== CONFIG ==================
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));
app.use('/webhook', require('./webhook/stripe-webhook'));

const redis = new Redis(process.env.REDIS_URL);

// Usa RPC HTTP stabile (HTTPS) – funziona sempre su Render
const web3 = new Web3('https://bsc-dataseed.binance.org/');

const NENO_ADDRESS = '0xeF3F5C1892A8d7A3304E4A15959E124402d69974';
const SERVICE_WALLET = web3.eth.accounts.privateKeyToAccount(process.env.PRIVATE_KEY).address;

// Prezzo NENO/EUR
let nenoPriceEUR = 0.0087;
const updatePrice = async () => {
  try {
    const res = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=neonoble&vs_currencies=eur');
    nenoPriceEUR = res.data.neonoble?.eur || 0.0087;
  } catch (e) {
    console.log('Prezzo NENO non aggiornato:', e.message);
  }
};
updatePrice();
setInterval(updatePrice, 30_000);

// ABI minima
const tokenAbi = [
  {
    "inputs": [{ "internalType": "address", "name": "owner", "type": "address" }],
    "name": "balanceOf",
    "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
    "stateMutability": "view",
    "type": "function"
  }
];
new web3.eth.Contract(tokenAbi, NENO_ADDRESS); // solo per tenere l'ABI

// ================== ENDPOINT CREAZIONE SESSIONE ==================
app.post('/create-session', async (req, res) => {
  const { tokenAmount, stripeAccountId } = req.body;
  const amount = parseFloat(tokenAmount);

  if (isNaN(amount) || amount < 10) {
    return res.status(400).json({ error: "Minimo 10 NENO" });
  }

  const eurGross = amount * nenoPriceEUR;
  const eurNet = new BigNumber(eurGross).multipliedBy(0.975).toFixed(2); // 2.5% fee

  const sessionId = Date.now().toString(36) + Math.random().toString(36).substr(2);

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
    message: `Invia esattamente \( {amount} NENO a \){SERVICE_WALLET}`
  });
});

// ================== LISTENER POLLING (FUNZIONA SEMPRE) ==================
let lastProcessedBlock = 0;

const startPollingListener = async () => {
  console.log('Listener NENO avviato con polling ogni 4 secondi (100% affidabile)');

  setInterval(async () => {
    try {
      const latestBlock = await web3.eth.getBlockNumber();
      if (latestBlock <= lastProcessedBlock) return;

      const fromBlock = lastProcessedBlock + 1;

      const logs = await web3.eth.getPastLogs({
        fromBlock: web3.utils.toHex(fromBlock),
        toBlock: 'latest',
        address: NENO_ADDRESS,
        topics: [
          web3.utils.sha3('Transfer(address,address,uint256)'),
          null,
          web3.utils.padLeft(SERVICE_WALLET, 64)
        ]
      });

      for (const log of logs) {
        const fromAddr = '0x' + log.topics[1].slice(-40);
        const valueRaw = new BigNumber(log.data);
        const value = valueRaw.dividedBy('1e18').toNumber();

        if (value < 10) continue;

        const txHash = log.transactionHash;
        const processedKey = `processed:${txHash}`;
        if (await redis.get(processedKey)) continue;

        await redis.set(processedKey, '1', 'EX', 86400 * 30); // 30 giorni

        // Cerca sessione corrispondente
        const pendingKeys = await redis.keys('pending:*');
        for (const key of pendingKeys) {
          const data = JSON.parse(await redis.get(key));
          if (Math.abs(data.amount - value) < 1 && data.status === 'waiting_transfer') {
            await redis.lpush('payout_queue', JSON.stringify({
              sessionKey: key,
              amountNENO: value,
              eurNet: data.eurNet,
              stripeAccountId: data.stripeAccountId,
              fromAddress: fromAddr,
              txHash
            }));

            await redis.set(key, JSON.stringify({ ...data, status: 'transfer_received', txHash, from: fromAddr }));
            console.log(`NENO RILEVATI: \( {value} NENO da \){fromAddr} → €${data.eurNet} in coda payout`);
            break;
          }
        }
      }

      lastProcessedBlock = latestBlock;
    } catch (err) {
      console.log('Polling error (riprovo tra 4s):', err.message);
    }
  }, 4000);
};

startPollingListener();

// ================== AVVIO SERVER ==================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`NENO Off-Ramp LIVE → https://neno-offramp-stripe.onrender.com`);
  console.log(`Wallet ricezione: ${SERVICE_WALLET}`);
  console.log(`Prezzo corrente NENO: €${nenoPriceEUR}`);
  console.log(`Listener polling attivo ogni 4 secondi`);
});
