import { neon } from '@neondatabase/serverless';
import { sendDirectMessage } from './helper.js';
import { pitchQueue } from './queue.js';


export const sql = neon(process.env.DATABASE_URL!);

async function hasUserReceivedPitch(recipientId: string, pitchId: string): Promise<boolean> {
    try {
        const result = await sql`
            SELECT 1 FROM pitch_history 
            WHERE recipient_id = ${recipientId} AND pitch_id = ${pitchId}
        `;
        return result.length > 0;
    } catch (error) {
        console.error("❌ Neon DB Read Error:", error);
        return true;
    }
}

async function logSentPitch(recipientId: string, pitchId: string, username: string): Promise<void> {
    try {
        await sql`
            INSERT INTO pitch_history (recipient_id, pitch_id, username) 
            VALUES (${recipientId}, ${pitchId}, ${username})
            ON CONFLICT (recipient_id, pitch_id) DO NOTHING;
        `;
    } catch (error) {
        console.error("❌ Neon DB Write Error:", error);
    }
}

// export async function handleIncomingPitchTrigger(recipientId: string, username: string, firstName: string) {
//     // FIX 1: Use a static string so the bot checks for the SAME pitch every time.
//     const PITCH_ID = "welcome_sales_pitch_v1"; 
//     const DELAY_TIME = 20 * 1000; 

//     // 🛡️ THE "ONE-TIME ONLY" GUARD
//     const alreadySent = await hasUserReceivedPitch(recipientId, PITCH_ID);
    
//     if (alreadySent) {
//         console.log(`🛡️ Guard Triggered: @${username} already got "${PITCH_ID}" or is in queue. Skipping.`);
//         return; 
//     }

//     await logSentPitch(recipientId, PITCH_ID, username);

//     console.log(`⏱️ Guard passed! DB Locked. Scheduling pitch for @${username} in 10 seconds...`);

//     // Create the delayed timer
//     setTimeout(async () => {
//         try {
//             // Send the actual message
//             await sendDirectMessage(
//                 recipientId, 
//                 `Hii ${firstName}!`
//             );

//             console.log(`✅ Pitch "${PITCH_ID}" successfully delivered to @${username}.`);

//         } catch (error) {
//             console.error(`❌ Failed to execute scheduled pitch for @${username}:`, error);
//         }
//     }, DELAY_TIME);

    
// }

export async function handleIncomingPitchTrigger(recipientId: string, firstName: string, username: string) {
    const PITCH_ID = "welcome_sales_pitch_v1"; 

    // 1. The Guard: Check if they already got it
    const alreadySent = await hasUserReceivedPitch(recipientId, PITCH_ID);
    
    if (alreadySent) {
        console.log(`🛡️ Guard Triggered: @${username} is already pitched. Skipping.`);
        return; 
    }

    // 2. The Lock: Save to Neon DB instantly so rapid messages are blocked
    await logSentPitch(recipientId, PITCH_ID, username);

    console.log(`⏱️ DB Locked. Sending job to Upstash Queue for @${username}...`);

    // 3. THE UPGRADE: Throw it into the Queue instead of Node.js memory!
    await pitchQueue.add(
        'send-pitch-job',                // Name of the job
        { recipientId, firstName, username }, // The data the worker needs
        { delay: 10 * 1000 }            // Delay execution by 10 seconds (10,000ms)
    );
}

export async function getOrCreateUser(igId: string, username: string, firstName: string) {
    try {
        // The ON CONFLICT DO NOTHING part is the magic. 
        // It prevents errors if the user says "hii" 50 times.
        await sql`
            INSERT INTO users (ig_id, username, first_name) 
            VALUES (${igId}, ${username}, ${firstName})
            ON CONFLICT (ig_id) DO NOTHING;
        `;
        
        // After ensuring they exist, fetch their current status
        const result = await sql`SELECT * FROM users WHERE ig_id = ${igId}`;
        return result[0]; // Returns { ig_id, is_subscriber, etc. }
    } catch (error) {
        console.error("❌ Failed to upsert user:", error);
        return null;
    }
}