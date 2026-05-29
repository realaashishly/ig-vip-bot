import { Queue, Worker, Job } from 'bullmq';
import { Redis } from 'ioredis';
import { sendDirectMessage } from './helper.js';

const redisConnection = new Redis(process.env.UPSTASH_REDIS_URL!, {
    maxRetriesPerRequest: null, // Required by BullMQ
});

export const pitchQueue = new Queue('pitch-queue', { 
    connection: redisConnection as any
});

const worker = new Worker('pitch-queue', async (job: Job) => {
    const { recipientId, username, firstName } = job.data;
    console.log(`⚙️ [WORKER] Processing delayed pitch for @${username}...`);

    try {
        await sendDirectMessage(
            recipientId, 
            `Hey ${firstName}!`
        );
        console.log(`✅ [WORKER] Pitch successfully delivered to @${username}.`);
    } catch (error) {
        console.error(`❌ [WORKER] Failed to send to @${username}:`, error);
        // If this throws an error (like a Meta API outage), BullMQ catches it
        // and will automatically try again later!
        throw error;
    }
}, { 
    connection: redisConnection as any,
    // Optional: Only process 5 messages per second to respect Meta rate limits
    limiter: {
        max: 5,
        duration: 1000 
    }
});

// Listeners just for your terminal logs
worker.on('completed', (job) => console.log(`🏁 Job ${job.id} finished.`));
worker.on('failed', (job, err) => console.error(`⚠️ Job ${job?.id} failed:`, err));