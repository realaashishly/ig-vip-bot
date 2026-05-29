import dotenv from 'dotenv';
import type { InstagramProfile, MetaMessagePayload, MetaMessageResponse } from '../type.js';
dotenv.config();

const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;

export async function getUserProfile(igsid: string): Promise<InstagramProfile | null>{
    if (!META_ACCESS_TOKEN) return null;

    const url = `https://graph.instagram.com/v25.0/${igsid}?fields=name,username,profile_pic`;

    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: { 
                // Uses the exact same token you already proved works!
                'Authorization': `Bearer ${META_ACCESS_TOKEN}`
            }
        });

        const data = (await response.json()) as InstagramProfile;

        if (response.ok && data.username) {
            return data;
        } else {
            console.error(`❌ Failed to fetch profile [Code ${data.error?.code}]:`, data.error?.message);
            return null;
        }

    } catch (error) {
        console.error("❌ Network error while fetching profile:", error);
        return null;
    }
}

// ---  The Main Function ---
export async function sendDirectMessage(recipientId: string, messageText: string): Promise<void> {
    if (!META_ACCESS_TOKEN) {
        console.error("❌ ERROR: META_ACCESS_TOKEN is not defined in your environment variables.");
        return;
    }

    const url = `https://graph.instagram.com/v25.0/me/messages`;

    const payload: MetaMessagePayload = {
        recipient: { id: recipientId },
        message: { text: messageText }
    };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                // CRITICAL FIX: The Bearer token header must be here, exactly like your successful cURL test!
                'Authorization': `Bearer ${META_ACCESS_TOKEN}`
            },
            body: JSON.stringify(payload)
        });

        const data = (await response.json()) as MetaMessageResponse;

        if (response.ok && data.message_id) {
            console.log(`✅ Message successfully sent! Message ID: ${data.message_id}`);
        } else {
            // FIX: Safely parse the exact error code and message from Meta
            console.error(
                `❌ Failed to send message. Meta API Error [Code ${data.error?.code}]:`,
                data.error?.message
            );
        }
    } catch (error) {
        if (error instanceof Error) {
            console.error("❌ Network error while attempting to send message:", error.message);
        } else {
            console.error("❌ An unexpected unknown error occurred:", error);
        }
    }
}

