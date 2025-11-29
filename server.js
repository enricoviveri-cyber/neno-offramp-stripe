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

// Redis (funziona con Upstash e Render)
const redis = new Redis(process.env.REDIS_URL, {
  tls: { rejectUnauthorized: false }
});

// RPC BSC ultra-stabile
const web3 = new Web3('https://bsc-dataseed1.defibit.io/');

const NENO_ADDRESS = '0xeF3F5C1892A8d7A3304E4A15959E124402d69974';
const SERVICE_WALLET = web3.eth.accounts.privateKeyToAccount(process.env.PRIVATE_KEY).address.toLowerCase();

// PREZZO FISSO COME RICHIESTO DA TE
const NENO_PRICE_EUR = 1000.00; // 1 NENO = 1000 €

console.log(`Prezzo NENO fissato a €${NENO_PRICE_EUR} per test`);

// ================== CREAZIONE SESSIONE ==================
app.post('/create-session', async (req, res) => {
  try {
    const { tokenAmount, stripeAccountId } = req.body;
    const amount = parseFloat(tokenAmount);

    if (isNaN(amount) || amount < 1) {
      return res.status(400).json({ error: "Importo minimo: 1 NENO" });
    }

    const eurGross = new BigNumber(amount).multipliedBy(NENO_PRICE_EUR);
    const eurNet = eurGross.multipliedBy(0.975).toFixed(2); // 2.5% fee

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
      message: `Invia esattamente ${amount} NENO a questo indirizzo`
    });

  } catch (err) {
    console.error('Errore create-session:', err.message);
    res.status(500).json({ error: "Errore server" });
  }
});

// ================== LISTENER POLLING ANTI-BIGINT ==================
let lastProcessedBlock = 0n;

const startListener = async () => {
  console.log('Listener NENO avviato – versione stabile 2025');

  try {
    const latest = await web3.eth.getBlockNumber();
    lastProcessedBlock = BigInt(latest);
    console.log(`Partenza dal blocco ${lastProcessedBlock}`);
  } catch (e) {
    lastProcessedBlock = 0n;
  }

  setInterval(async () => {
    try {
      const latest = BigInt(await web3.eth.getBlockNumber());
      if (latest <= lastProcessedBlock) return;

      const fromBlock = lastProcessedBlock + 1n;

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
        const valueBN = BigInt(log.data);
        const value = Number(valueBN / 10n ** 18n);

        if (value < 1) continue;

        const txHash = log.transactionHash;
        if (await redis.exists(`proc:${txHash}`)) continue;

        const fromAddr = '0x' + log.topics[1].slice(-40).toLowerCase();

        const keys = await redis.keys('pending:*');
        for (const key of keys) {
          const session = JSON.parse(await redis.get(key));
          if (Math.abs(session.amount - value) < 0.0001 && session.status === 'waiting_transfer') {
            await redis.lpush('payout_queue', JSON.stringify({
              sessionKey: key,
              amountNENO: value,
              eurNet: session.eurNet,
              stripeAccountId: session.stripeAccountId,
              fromAddress: fromAddr,
              txHash
            }));
            await redis.set(key, JSON.stringify({ ...session, status: 'transfer_received', from: fromAddr, txHash }));
            console.log(`RICEVUTO \( {value} NENO da \){fromAddr.slice(0,8)}... → €${session.eurNet}`);
            await redis.set(`proc:${txHash}`, '1', 'EX', 2592000);
            break;
          }
        }
      }

      lastProcessedBlock = latest;

    } catch (err) {
      console.log('Polling temporaneo fallito (riprovo):', err.message.slice(0, 100));
    }
  }, 7000);
};

startListener();

// ================== START SERVER ==================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('NENO OFF-RAMP ONLINE CON PREZZO 1000€');
  console.log(`https://neno-offramp-stripe.onrender.com`);
  console.log(`Wallet: ${SERVICE_WALLET}`);
  console.log('Listener attivo – tutto stabile');
});
