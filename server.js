require('dotenv').config();
const express = require('express');
const { Web3 } = require('web3');           // Web3 v4 corretto
const axios = require('axios');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const Redis = require('ioredis');
const BigNumber = require('bignumber.js');

// ================== APP SETUP ==================
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));
app.use('/webhook', require('./webhook/stripe-webhook'));

const redis = new Redis(process.env.REDIS_URL);

// RPC HTTP stabile (sempre funzionante su Render)
const web3 = new Web3('https://bsc-dataseed.binance.org/');

const NENO_ADDRESS = '0xeF3F5C1892A8d7A3304E4A15959E124402d69974';
const SERVICE_WALLET = web3.eth.accounts.privateKeyToAccount(process.env.PRIVATE_KEY).address.toLowerCase();

// ================== PREZZO NENO/EUR ==================
let nenoPriceEUR = 0.0087;
const updatePrice = async () => {
  try {
    const res = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=neonoble&vs_currencies=eur', { timeout: 8000 });
    nenoPriceEUR = res.data.neonoble?.eur || nenoPriceEUR;
  } catch (e) {
    console.log('Prezzo NENO non aggiornato (uso ultimo valore)');
  }
};
updatePrice();
setInterval(updatePrice, 30_000);

// ================== ENDPOINT CREAZIONE SESSIONE ==================
app.post('/create-session', async (req, res) => {
  const { tokenAmount, stripeAccountId } = req.body;
  const amount = parseFloat(tokenAmount);

  if (isNaN(amount) || amount < 10) {
    return res.status(400).json({ error: "Importo minimo: 10 NENO" });
  }

  const eurNet = new BigNumber(amount).multipliedBy(nenoPriceEUR).multipliedBy(0.975).toFixed(2); // 2.5% fee

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
    fee: "2.5%",
    message: `Invia esattamente ${amount} NENO a questo indirizzo BSC`
  });
});

// ================== LISTENER POLLING ULTRA-STABILE ==================
let lastProcessedBlock = 0;

const startPollingListener = async () => {
  console.log('Avvio listener NENO con polling ultra-stabile (ogni 6 secondi)');

  // Inizializza blocco corrente
  try {
    lastProcessedBlock = await web3.eth.getBlockNumber();
    console.log(`Blocco di partenza: ${lastProcessedBlock}`);
  } catch (e) {
    console.log('Impossibile leggere blocco iniziale → parto da 0');
    lastProcessedBlock = 0;
  }

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

      if (logs.length === 0) {
        lastProcessedBlock = latestBlock;
        return;
      }

      for (const log of logs) {
        const fromAddr = '0x' + log.topics[1].slice(-40).toLowerCase();
        const value = new BigNumber(log.data).dividedBy('1e18').toNumber();
        const txHash = log.transactionHash;

        if (value < 10) continue;

        const processedKey = `processed:${txHash}`;
        if (await redis.exists(processedKey)) continue;

        await redis.set(processedKey, '1', 'EX', 2592000); // 30 giorni

        // Cerca sessione pending corrispondente
        const pendingKeys = await redis.keys('pending:*');
        for (const key of pendingKeys) {
          const sessionData = JSON.parse(await redis.get(key));
          if (
            Math.abs(sessionData.amount - value) < 1 &&
            sessionData.status === 'waiting_transfer'
          ) {
            await redis.lpush('payout_queue', JSON.stringify({
              sessionKey: key,
              amountNENO: value,
              eurNet: sessionData.eurNet,
              stripeAccountId: sessionData.stripeAccountId,
              fromAddress: fromAddr,
              txHash
            }));

            await redis.set(key, JSON.stringify({
              ...sessionData,
              status: 'transfer_received',
              from: fromAddr,
              txHash,
              receivedAt: Date.now()
            }));

            console.log(`NENO RICEVUTI: \( {value} da \){fromAddr} → €\( {sessionData.eurNet} | TX: \){txHash.slice(0, 10)}...`);
            break;
          }
        }
      }

      lastProcessedBlock = latestBlock;

    } catch (err) {
      console.log(`Polling temporaneo fallito (riprovo tra 6s): ${err.message.substring(0, 120)}`);
    }
  }, 6000); // 6 secondi = gentile con il nodo pubblico
};

startPollingListener();

// ================== AVVIO SERVER ==================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('NENO OFF-RAMP LIVE E STABILE');
  console.log(`https://neno-offramp-stripe.onrender.com`);
  console.log(`Wallet ricezione: ${SERVICE_WALLET}`);
  console.log(`Prezzo attuale: €${nenoPriceEUR}`);
  console.log('Listener polling attivo – nessun crash garantito');
});
