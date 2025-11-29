require('dotenv').config();
const Redis = require('ioredis');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Upstash usa rediss:// → TLS obbligatorio
const redis = new Redis(process.env.REDIS_URL, {
  tls: {
    rejectUnauthorized: false   // necessario con Upstash
  }
});

console.log('NENO PAYOUT WORKER avviato e in ascolto sulla coda...');

const processQueue = async () => {
  while (true) {
    try {
      // brpop con timeout infinito (0) – aspetta fino a che arriva un job
      const result = await redis.brpop('payout_queue', 0);
      const rawJob = result[1];
      const data = JSON.parse(rawJob);

      const { sessionKey, amountNENO, eurNet, stripeAccountId, fromAddress, txHash } = data;

      console.log(`PAGAMENTO IN CORSO: €\( {eurNet} ( \){amountNENO} NENO) → ${fromAddress.slice(0,10)}...`);

      const transfer = await stripe.transfers.create({
        amount: Math.round(parseFloat(eurNet) * 100), // centesimi
        currency: 'eur',
        destination: stripeAccountId,
        source_type: 'bank_account', // o 'card' se serve
        description: `Off-ramp NENO → EUR | TX: \( {txHash.slice(0,10)}... | \){amountNENO} NENO`
      });

      // Aggiorna la sessione come pagata
      const updatedSession = {
        ...data,
        status: 'paid',
        paidAt: Date.now(),
        stripeTransferId: transfer.id
      };
      await redis.set(sessionKey.replace('pending:', 'completed:'), JSON.stringify(updatedSession));
      await redis.del(sessionKey); // rimuovi da pending

      console.log(`PAGAMENTO COMPLETATO: €\( {eurNet} inviato (ID: \){transfer.id})`);

    } catch (err) {
      console.error('ERRORE PAGAMENTO – rimesso in coda:', err.message);

      // Rimette in coda per retry (massimo 5 tentativi consigliati)
      try {
        const retryJob = JSON.parse(rawJob || '{}');
        retryJob.retryCount = (retryJob.retryCount || 0) + 1;
        if (retryJob.retryCount <= 5) {
          await redis.lpush('payout_queue', JSON.stringify(retryJob));
          console.log(`Retry ${retryJob.retryCount}° tentativo`);
        } else {
          console.error('TROPPI FALLIMENTI – job scartato:', rawJob);
          // Opzionale: salva in una dead-letter queue
          await redis.lpush('failed_payouts', rawJob);
        }
      } catch {}
    }
  }
};

// Avvia e proteggi da crash
processQueue().catch(err => {
  console.error('WORKER CRASHATO:', err);
  process.exit(1); // Render lo riavvia automaticamente
});
