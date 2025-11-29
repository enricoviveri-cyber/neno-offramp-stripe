require('dotenv').config();
const Redis = require('ioredis');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const redis = new Redis(process.env.REDIS_URL);

const processQueue = async () => {
  while (true) {
    const job = await redis.brpop('payout_queue', 0);
    const { sessionKey, eurNet, stripeAccountId } = JSON.parse(job[1]);

    try {
      const transfer = await stripe.transfers.create({
        amount: Math.round(parseFloat(eurNet) * 100),
        currency: 'eur',
        destination: stripeAccountId,
        description: `Off-ramp NENO → EUR`
      });

      await redis.set(sessionKey, JSON.stringify({ status: 'paid', transferId: transfer.id }));
      console.log(`Payout inviato: €\( {eurNet} → \){stripeAccountId}`);
    } catch (err) {
      console.error('Payout fallito:', err.message);
      await redis.lpush('payout_queue', job[1]); // retry
    }
  }
};

processQueue();
