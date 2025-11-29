require('dotenv').config();
const express = require('express');
const Web3 = require('web3');
const axios = require('axios');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const Redis = require('ioredis');
const BigNumber = require('bignumber.js');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));
app.use('/webhook', require('./webhook/stripe-webhook'));

const redis = new Redis(process.env.REDIS_URL);
const web3 = new Web3('wss://bsc-rpc.publicnode.com'); // WebSocket per real-time

const NENO_ADDRESS = '0xeF3F5C1892A8d7A3304E4A15959E124402d69974';
const SERVICE_WALLET = web3.eth.accounts.privateKeyToAccount(process.env.PRIVATE_KEY).address;

// Prezzo NENO/EUR
let nenoPriceEUR = 0.0087;
const updatePrice = async () => {
  try {
    const res = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=neonoble&vs_currencies=eur');
    nenoPriceEUR = res.data.neonoble?.eur || 0.0087;
  } catch (e) {}
};
updatePrice();
setInterval(updatePrice, 30_000);

// ERC20 ABI minimal
const tokenAbi = [{"inputs":[{"internalType":"address","name":"owner","type":"address"}],"name":"balanceOf","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"from","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"transfer","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"}];
const tokenContract = new web3.eth.Contract(tokenAbi, NENO_ADDRESS);

// Crea sessione + salva in Redis
app.post('/create-session', async (req, res) => {
  const { tokenAmount, stripeAccountId } = req.body;
  const amount = parseFloat(tokenAmount);

  if (amount < 10) return res.status(400).json({ error: "Minimo 10 NENO" });

  const eurNet = new BigNumber(amount).times(nenoPriceEUR).times(0.975).toFixed(2); // 2.5% fee

  const sessionId = Date.now() + Math.random().toString(36);
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
    message: `Invia \( {amount} NENO a \){SERVICE_WALLET}`
  });
});

// Listener real-time trasferimenti NENO
let lastBlock = 0;
const startListener = async () => {
  console.log("Listener NENO attivo...");
  const subscription = web3.eth.subscribe('newBlockHeaders');
  subscription.on('data', async (blockHeader) => {
    if (blockHeader.number <= lastBlock) return;
    lastBlock = blockHeader.number;

    const logs = await web3.eth.getPastLogs({
      fromBlock: web3.utils.toHex(blockHeader.number),
      toBlock: web3.utils.toHex(blockHeader.number),
      address: NENO_ADDRESS,
      topics: [web3.utils.sha3('Transfer(address,address,uint256)'), null, web3.utils.padLeft(SERVICE_WALLET, 64)]
    });

    for (const log of logs) {
      const from = '0x' + log.topics[1].slice(26);
      const value = new BigNumber(log.data).div(1e18).toNumber();
      if (value < 10) continue;

      const key = `processed:${log.transactionHash}`;
      if (await redis.get(key)) continue;
      await redis.set(key, '1', 'EX', 86400);

      // Cerca sessione corrispondente
      const keys = await redis.keys('pending:*');
      for (const k of keys) {
        const data = JSON.parse(await redis.get(k));
        if (Math.abs(data.amount - value) < 0.1 && data.status === 'waiting_transfer') {
          await redis.lpush('payout_queue', JSON.stringify({
            sessionKey: k,
            amountNENO: value,
            eurNet: data.eurNet,
            stripeAccountId: data.stripeAccountId
          }));
          await redis.set(k, JSON.stringify({ ...data, status: 'transfer_received' }));
          console.log(`NENO ricevuti da \( {from} → \){value} NENO → €${data.eurNet}`);
          break;
        }
      }
    }
  });
};
startListener();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`NENO Off-Ramp LIVE su porta ${PORT}`);
  console.log(`Wallet: ${SERVICE_WALLET}`);
});
