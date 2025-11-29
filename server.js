require('dotenv').config();
const express = require('express');
const { Web3 } = require('web3');           // CORRETTO per v4+
const axios = require('axios');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const Redis = require('ioredis');
const BigNumber = require('bignumber.js');

// ------------------- Config -------------------
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));
app.use('/webhook', require('./webhook/stripe-webhook'));

const redis = new Redis(process.env.REDIS_URL);

const web3 = new Web3('wss://bsc-rpc.publicnode.com'); // WebSocket real-time

const NENO_ADDRESS = '0xeF3F5C1892A8d7A3304E4A15959E124402d69974';
const SERVICE_WALLET = web3.eth.accounts.privateKeyToAccount(process.env.PRIVATE_KEY).address;

// Prezzo NENO/EUR (aggiornato ogni 30s)
let nenoPriceEUR = 0.0087;
const updatePrice = async () => {
  try {
    const res = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=neonoble&vs_currencies=eur');
    nenoPriceEUR = res.data.neonoble?.eur || 0.0087;
  } catch (e) {
    console.log('Prezzo non aggiornato:', e.message);
  }
};
updatePrice();
setInterval(updatePrice, 30_000);

// ABI minima per Transfer e balanceOf
const tokenAbi = [
  { "inputs": [{ "internalType": "address", "name": "owner", "type": "address" }], "name": "balanceOf", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "stateMutability": "view", "type": "function" },
  { "inputs": [{ "internalType": "address", "name": "from", "type": "address" }, { "internalType": "uint256", "name": "amount", "type": "uint256" }], "name": "transfer", "outputs": [{ "internalType": "bool", "name": "", "type": "bool" }], "stateMutability": "nonpayable", "type": "function" }
];
const tokenContract = new web3.eth.Contract(tokenAbi, NENO_ADDRESS);

// ------------------- Endpoint creazione sessione -------------------
app.post('/create-session', async (req, res) => {
  const { tokenAmount, stripeAccountId } = req.body;
  const amount = parseFloat(tokenAmount);

  if (isNaN(amount) || amount < 10) {
    return res.status(400).json({ error: "Minimo 10 NENO" });
  }

  const eurGross = amount * nenoPriceEUR;
  const eurNet = new BigNumber(eurGross).times(0.975).toFixed(2); // 2.5% fee

  const sessionId = Date.now().toString(36) + Math.random().toString(36).substr(2);

  await redis.setex(`pending:${sessionId}`, 3600, JSON.stringify({
    amount,
    eurNet,
    stripeAccountId,
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

// ------------------- Listener blockchain real-time -------------------
let lastBlock = 0;

const startListener = async () => {
  console.log('Listener NENO real-time avviato...');

  const subscription = web3.eth.subscribe('newBlockHeaders');
  subscription.on('data', async (header) => {
    if (header.number <= lastBlock) return;
    lastBlock = header.number;

    try {
      const logs = await web3.eth.getPastLogs({
        fromBlock: web3.utils.toHex(header.number),
        toBlock: web3.utils.toHex(header.number),
        address: NENO_ADDRESS,
        topics: [
          web3.utils.sha3('Transfer(address,address,uint256)'),
          null,
          web3.utils.padLeft(SERVICE_WALLET, 64)
        ]
      });

      for (const log of logs) {
        const from = '0x' + log.topics[1].slice(-40);
        const value = new BigNumber(log.data).div('1e18').toNumber();

        if (value < 10) continue;

        const processedKey = `processed:${log.transactionHash}`;
        if (await redis.get(processedKey)) continue;
        await redis.set(processedKey, '1', 'EX', 86400 * 7);

        // Cerca sessione corrispondente
        const keys = await redis.keys('pending:*');
        for (const key of keys) {
          const data = JSON.parse(await redis.get(key));
          if (Math.abs(data.amount - value) < 0.5 && data.status === 'waiting_transfer') {
            await redis.lpush('payout_queue', JSON.stringify({
              sessionKey: key,
              amountNENO: value,
              eurNet: data.eurNet,
              stripeAccountId: data.stripeAccountId
            }));
            await redis.set(key, JSON.stringify({ ...data, status: 'transfer_received', from }));
            console.log(`NENO ricevuti! \( {value} da \){from} → €${data.eurNet} in coda payout`);
            break;
          }
        }
      }
    } catch (err) {
      console.log('Errore listener:', err.message);
    }
  });

  subscription.on('error', err => console.log('Subscription error:', err));
};

startListener();

// ------------------- Avvio server -------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`NENO Off-Ramp LIVE → https://neno-offramp-stripe.onrender.com`);
  console.log(`Wallet ricezione: ${SERVICE_WALLET}`);
  console.log(`Prezzo corrente: €${nenoPriceEUR}`);
});
