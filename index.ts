import dotenv from "dotenv";
dotenv.config();

import express, { type Request, type Response } from "express";
import bodyParser from "body-parser";
import { getUserProfile, sendDirectMessage } from "./services/helper.js";
import {
  getOrCreateUser,
  handleIncomingPitchTrigger,
  sql,
} from "./services/subcriptionLink.js";
import "./services/queue.js";
import { Cashfree, CFEnvironment } from "cashfree-pg";

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 8000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;

export const cashfree = new Cashfree(
  CFEnvironment.SANDBOX,
  process.env.CASHFREE_APP_ID!,
  process.env.CASHFREE_SECRET_KEY!,
);

if (!VERIFY_TOKEN || !META_ACCESS_TOKEN) {
  console.error(
    "❌ CRITICAL ERROR: Missing VERIFY_TOKEN or META_ACCESS_TOKEN in your .env file!",
  );
  process.exit(1);
}

app.get("/", (req, res) => {
  res.status(200).send(`Backend Alive`);
});

app.get("/webhook", (req: Request, res: Response): void => {
  const mode = req.query["hub.mode"] as string;
  const token = req.query["hub.verify_token"] as string;
  const challenge = req.query["hub.challenge"] as string;

  if (mode && token) {
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("✅ WEBHOOK_VERIFIED by Meta");
      res.status(200).set("Content-Type", "text/plain").send(challenge);
    } else {
      console.error(
        `❌ VERIFICATION_FAILED: Expected ${VERIFY_TOKEN}, got ${token}`,
      );
      res.sendStatus(403);
    }
  } else {
    console.error("❌ BAD REQUEST: Missing mode or token parameters");
    res.sendStatus(400);
  }
});

app.post("/webhook", async (req: Request, res: Response): Promise<void> => {
  const body = req.body;

  console.log("webhook triggered", body);

  if (body.object === "instagram") {
    res.status(200).send("EVENT_RECEIVED");

    try {
      for (const entry of body.entry) {
        // Safely check if messaging array exists
        const webhookEvent = entry.messaging?.[0];

        // If there is no messaging event OR no sender ID, skip it entirely
        if (!webhookEvent || !webhookEvent.sender?.id) {
          continue;
        }

        const senderId = webhookEvent.sender.id;

        if (!senderId) continue;

        if (senderId === "17841466457907514" || webhookEvent.message?.is_echo) {
          console.log("🤫 Ignored bot's own outgoing message.");
          continue;
        }

        // Only trigger the reply if it is specifically a text message
        if (webhookEvent.message?.text) {
          const incomingText = webhookEvent.message.text.toLowerCase();
          console.log(`💬 Incoming DM from ${senderId}: "${incomingText}"`);

          const userProfile = await getUserProfile(senderId);
          const username = userProfile?.username || "unknown";
          const firstName = userProfile?.name?.split(" ")[0] || "";

          const dbUser = await getOrCreateUser(senderId, username, firstName);

          if (dbUser?.is_subscriber) {
            if (incomingText === "help") {
              await sendDirectMessage(
                senderId,
                `Hey ${firstName}, what do you need help with?`,
              );
            } else {
              await sendDirectMessage(
                senderId,
                `Welcome back to the VIP area, ${firstName}!`,
              );
            }

            console.log(`Message sent successfully to @${username}! 🚀`);
          } else {
            await handleIncomingPitchTrigger(senderId, username, firstName);
            // await sendDirectMessage(senderId, `Hii`);
            console.log(`Pitched to @${username}! for subscription`);
          }
        }
      }
    } catch (error) {
      console.error("❌ Error processing webhook event:", error);
    }
  } else {
    res.sendStatus(404);
  }
});

app.post("/create-payment", async (req, res) => {
  const { userId } = req.body;

  try {
    const request = {
      order_amount: 10.0,
      order_currency: "INR",
      order_id: `order_${userId}_${Date.now()}`, 
      customer_details: {
        customer_id: userId,
        customer_phone: "9999999999",
        customer_name: "Instagram User",
      },
      order_meta: {
        return_url: `https://ig-vip-bot.onrender.com/success?order_id={order_id}`, // Updated to your domain
      },
    };

    const response = await cashfree.PGCreateOrder(request);

    // Send the session ID back to your webpage
    res.json({ payment_session_id: response.data.payment_session_id });
  } catch (error) {
    // 1. This prints the exact error into your Render Logs!
    console.error("Cashfree Order Creation Failed:", error.response?.data || error.message || error);

    // 2. This alerts the frontend so the button unlocks instead of hanging
    res.status(500).json({ error: "Failed to initialize payment session" });
  }
});

app.post("/cashfree-webhook", async (req, res) => {
    // Cashfree expects an immediate 200 OK, just like Meta
    res.status(200).send("OK");

    try {
        const payload = req.body;
        
        // 1. Verify the payment was actually successful
        if (payload.data.payment.payment_status === "SUCCESS") {
            
            const orderId = payload.data.order.order_id;
            
            // 2. Extract the Instagram ID from the order_id we created earlier
            // E.g., 'order_123456789_170000000' -> split gives us '123456789'
            const igId = orderId.split("_")[1]; 

            console.log(`💰 Payment of ₹10 received from IG User: ${igId}`);

            // 3. Unlock them in Neon DB
            await sql`
                UPDATE users 
                SET is_subscriber = true 
                WHERE ig_id = ${igId}
            `;

            // 4. Send the automated welcome message via Meta!
            await sendDirectMessage(
                igId, 
                "Payment received! 🎉 Now I can talk to you. What's on your mind?"
            );
        }
    } catch (error) {
        console.error("❌ Error processing Cashfree webhook:", error);
    }
});

// Serve the Checkout Page
app.get("/checkout", (req, res) => {
    const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Priority Chat</title>
        <script src="https://sdk.cashfree.com/js/v3/cashfree.js"></script>
        <link href="https://fonts.googleapis.com/css2?family=Caprasimo&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,700&display=swap" rel="stylesheet">
        <style>
            /* Base Reset & Styling */
            * {
                box-sizing: border-box;
                margin: 0;
                padding: 0;
            }

            body {
                font-family: 'DM Sans', sans-serif;
                background-color: #8DE0CC; /* Vibrant retro mint green */
                display: flex;
                justify-content: center;
                align-items: center;
                min-height: 100vh;
                padding: 20px;
            }

            /* Variables for the happy vintage theme colors */
            :root {
                --card-base-color: #FF9F1C; /* Vibrant sunshine orange */
                --text-light: #FFFCF2; /* Creamy warm white */
                --text-dark: #590D22; /* Deep retro maroon/brown */
                --accent-teal: #2EC4B6; /* Happy retro teal */
                --accent-yellow: #FFBF69; /* Warm sunny yellow */
            }

            /* The Main Card Container */
            .card {
                width: 100%;
                max-width: 350px;
                height: 620px;
                border-radius: 44px; 
                position: relative;
                overflow: hidden;
                background-color: var(--card-base-color);
                box-shadow: 0 24px 48px rgba(89, 13, 34, 0.15);
            }

            /* SVG Noise Overlay for Vintage Film Grain Effect */
            .card::after {
                content: '';
                position: absolute;
                inset: 0;
                background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)' opacity='0.06' style='mix-blend-mode: multiply;'/%3E%3C/svg%3E");
                pointer-events: none; 
                z-index: 10;
            }

            /* Image Layer */
            .card-image {
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 65%; 
                /* Your profile image goes here */
                background-image: url('https://images.unsplash.com/photo-1618077360395-f3068be8e001?q=80&w=500&auto=format&fit=crop');
                background-size: cover;
                background-position: center;
                filter: sepia(0.15) contrast(1.15) brightness(1.05) saturate(1.4);
                z-index: 1;
            }

            /* Gradient Overlay Layer */
            .card-overlay {
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: linear-gradient(
                    to bottom,
                    rgba(255, 159, 28, 0) 30%,
                    rgba(255, 159, 28, 0.75) 55%,
                    var(--card-base-color) 70%
                );
                z-index: 2;
            }

            /* Top Right Discount Badge */
            .discount-badge {
                position: absolute;
                top: 24px;
                right: 24px;
                background-color: var(--accent-teal);
                border: 2px solid var(--text-dark);
                color: var(--text-light);
                padding: 6px 14px;
                border-radius: 20px;
                font-family: 'DM Sans', sans-serif;
                font-size: 13px;
                font-weight: 700;
                z-index: 3;
                letter-spacing: 0.5px;
                box-shadow: 2px 2px 0px var(--text-dark);
                transform: rotate(4deg);
            }

            /* Content Container */
            .card-content {
                position: absolute;
                bottom: 0;
                left: 0;
                width: 100%;
                padding: 28px;
                z-index: 3;
                display: flex;
                flex-direction: column;
            }

            /* Carousel Indicators */
            .carousel-dots {
                display: flex;
                justify-content: center;
                gap: 6px;
                margin-bottom: 24px;
            }

            .dot {
                width: 6px;
                height: 6px;
                border-radius: 50%;
                background-color: rgba(255, 252, 242, 0.4);
            }

            .dot.active {
                background-color: var(--text-light);
                transform: scale(1.3);
            }

            /* Title and Price Row */
            .header-row {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 16px;
            }

            .title {
                color: var(--text-light);
                font-family: 'Caprasimo', serif;
                font-size: 32px;
                letter-spacing: 0.5px;
                text-shadow: 2px 3px 0px rgba(89, 13, 34, 0.25); 
            }

            .price-badge {
                background-color: var(--accent-yellow);
                color: var(--text-dark);
                font-family: 'Caprasimo', serif;
                font-size: 18px;
                padding: 7px 16px;
                border-radius: 20px;
                border: 2px solid var(--text-dark);
                box-shadow: 2px 3px 0px var(--text-dark);
                transform: rotate(-2deg);
            }

            /* Product Description */
            .description {
                color: var(--text-light);
                font-size: 15px; 
                font-weight: 500;
                line-height: 1.5;
                margin-bottom: 24px;
            }

            /* Tags Row */
            .tags-row {
                display: flex;
                gap: 12px;
                margin-bottom: 30px;
            }

            .tag {
                background-color: var(--text-light);
                border: 2px solid var(--text-dark);
                color: var(--text-dark);
                padding: 7px 16px;
                border-radius: 20px;
                font-family: 'DM Sans', sans-serif;
                font-weight: 700;
                font-size: 13px;
                box-shadow: 2px 2px 0px var(--text-dark);
            }

            /* Action Button */
            .add-to-cart-btn {
                width: 100%;
                background-color: var(--accent-teal);
                color: var(--text-light);
                border: 3px solid var(--text-dark);
                padding: 16px;
                border-radius: 30px;
                font-family: 'Caprasimo', serif;
                font-size: 18px;
                cursor: pointer;
                transition: all 0.15s ease;
                box-shadow: 3px 4px 0px var(--text-dark); 
            }

            .add-to-cart-btn:hover {
                background-color: #25a99d; 
                transform: translate(-1px, -2px);
                box-shadow: 4px 6px 0px var(--text-dark);
            }

            .add-to-cart-btn:active {
                transform: translate(2px, 3px);
                box-shadow: 0px 0px 0px var(--text-dark);
            }

            /* Error Message Styling */
            .error-message {
                text-align: center;
                color: var(--text-dark);
                font-weight: 700;
                font-size: 14px;
                margin-top: 12px;
                display: none;
                background-color: var(--accent-yellow);
                padding: 8px;
                border-radius: 8px;
                border: 2px solid var(--text-dark);
            }
        </style>
    </head>
    <body>

        <div class="card">
            <div class="card-image"></div>
            
            <div class="card-overlay"></div>

            <div class="discount-badge">VIP Access</div>

            <div class="card-content">
                
                <div class="carousel-dots">
                    <span class="dot active"></span>
                    <span class="dot"></span>
                    <span class="dot"></span>
                </div>

                <div class="header-row">
                    <h1 class="title">Priority</h1>
                    <div class="price-badge">₹10</div>
                </div>

                <p class="description">
                    Loved by followers for quick responses. Unlock direct DMs and bypass the sorting queue instantly.
                </p>

                <div class="tags-row">
                    <span class="tag">Fast Reply</span>
                    <span class="tag">1-on-1</span>
                </div>

                <button id="pay-btn" class="add-to-cart-btn">Unlock Access</button>
                <div id="error-msg" class="error-message"></div>
                
            </div>
        </div>

        <script>
            // Cashfree logic wired up to your retro button
            const urlParams = new URLSearchParams(window.location.search);
            const userId = urlParams.get('userId');
            const cashfree = Cashfree({ mode: "sandbox" });

            const payBtn = document.getElementById('pay-btn');
            const errorMsg = document.getElementById('error-msg');

            payBtn.addEventListener('click', async () => {
                if (!userId) {
                    errorMsg.innerText = "Invalid link. Please use the link in your DMs.";
                    errorMsg.style.display = 'block';
                    return;
                }

                payBtn.innerText = "Connecting...";
                payBtn.style.opacity = "0.9";
                payBtn.style.transform = "translate(2px, 3px)";
                payBtn.style.boxShadow = "0px 0px 0px var(--text-dark)";
                payBtn.disabled = true;

                try {
                    const response = await fetch('/create-payment', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ userId: userId })
                    });
                    
                    const data = await response.json();

                    if (data.payment_session_id) {
                        cashfree.checkout({
                            paymentSessionId: data.payment_session_id,
                            redirectTarget: "_self" 
                        });
                    } else {
                        throw new Error("No session ID");
                    }
                } catch (error) {
                    errorMsg.innerText = "System busy. Please try again.";
                    errorMsg.style.display = 'block';
                    payBtn.innerText = "Unlock Access";
                    payBtn.style.opacity = "1";
                    payBtn.style.transform = "none";
                    payBtn.style.boxShadow = "3px 4px 0px var(--text-dark)";
                    payBtn.disabled = false;
                }
            });
        </script>
    </body>
    </html>
    `;
    
    res.send(html);
});


app.get("/success", (req, res) => {
    const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Payment Successful</title>
        <!-- Importing the same happy retro fonts -->
        <link href="https://fonts.googleapis.com/css2?family=Caprasimo&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,700&display=swap" rel="stylesheet">
        <style>
            * {
                box-sizing: border-box;
                margin: 0;
                padding: 0;
            }

            :root {
                --card-base-color: #FF9F1C;
                --text-light: #FFFCF2;
                --text-dark: #590D22;
                --accent-teal: #2EC4B6;
                --accent-yellow: #FFBF69;
                --bg-mint: #8DE0CC;
            }

            body {
                font-family: 'DM Sans', sans-serif;
                background-color: var(--bg-mint);
                display: flex;
                justify-content: center;
                align-items: center;
                min-height: 100vh;
                padding: 20px;
                text-align: center;
            }

            /* Vintage Film Grain Effect */
            body::after {
                content: '';
                position: absolute;
                inset: 0;
                background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)' opacity='0.06' style='mix-blend-mode: multiply;'/%3E%3C/svg%3E");
                pointer-events: none;
                z-index: 10;
            }

            .success-card {
                background-color: var(--text-light);
                border: 4px solid var(--text-dark);
                box-shadow: 8px 10px 0px var(--text-dark); /* Chunky pop-art shadow */
                border-radius: 36px;
                padding: 48px 32px;
                max-width: 400px;
                width: 100%;
                position: relative;
                z-index: 20;
            }

            .icon-wrapper {
                width: 80px;
                height: 80px;
                background-color: var(--accent-yellow);
                border: 3px solid var(--text-dark);
                box-shadow: 3px 4px 0px var(--text-dark);
                border-radius: 50%;
                display: flex;
                justify-content: center;
                align-items: center;
                margin: 0 auto 24px auto;
                font-size: 36px;
                transform: rotate(-5deg); /* Playful tilt */
            }

            h1 {
                font-family: 'Caprasimo', serif;
                color: var(--text-dark);
                font-size: 32px;
                margin-bottom: 16px;
                letter-spacing: 0.5px;
            }

            p {
                color: var(--text-dark);
                font-size: 16px;
                font-weight: 500;
                line-height: 1.6;
                margin-bottom: 32px;
            }

            .highlight {
                color: var(--accent-teal);
                font-weight: 700;
            }

            .close-btn {
                background-color: var(--accent-teal);
                color: var(--text-light);
                border: 3px solid var(--text-dark);
                padding: 16px 28px;
                border-radius: 30px;
                font-family: 'Caprasimo', serif;
                font-size: 18px;
                cursor: pointer;
                box-shadow: 3px 4px 0px var(--text-dark);
                transition: all 0.15s ease;
                display: inline-block;
                width: 100%;
            }

            .close-btn:active {
                transform: translate(2px, 3px);
                box-shadow: 0px 0px 0px var(--text-dark);
            }
        </style>
    </head>
    <body>
        <div class="success-card">
            <div class="icon-wrapper">🎉</div>
            <h1>Payment Successful!</h1>
            <p>You have officially unlocked <span class="highlight">VIP Priority Chat</span>. I just sent you a message!</p>
            
            <!-- Button tries to close the tab so they can easily go back to the IG app -->
            <button onclick="window.close()" class="close-btn">Return to Instagram</button>
        </div>
    </body>
    </html>
    `;
    
    res.send(html);
});

app.get("/terms", (req, res) => {
    const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Terms and Conditions</title>
        <link href="https://fonts.googleapis.com/css2?family=Caprasimo&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,700&display=swap" rel="stylesheet">
        <style>
            * {
                box-sizing: border-box;
                margin: 0;
                padding: 0;
            }

            :root {
                --card-base-color: #FF9F1C;
                --text-light: #FFFCF2;
                --text-dark: #590D22;
                --accent-teal: #2EC4B6;
                --bg-mint: #8DE0CC;
            }

            body {
                font-family: 'DM Sans', sans-serif;
                background-color: var(--bg-mint);
                color: var(--text-dark);
                padding: 40px 20px;
                line-height: 1.6;
                position: relative;
            }

            /* Vintage Film Grain Effect */
            body::after {
                content: '';
                position: fixed;
                inset: 0;
                background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)' opacity='0.06' style='mix-blend-mode: multiply;'/%3E%3C/svg%3E");
                pointer-events: none;
                z-index: 10;
            }

            .legal-container {
                max-width: 800px;
                margin: 0 auto;
                background-color: var(--text-light);
                border: 4px solid var(--text-dark);
                box-shadow: 8px 10px 0px var(--text-dark);
                border-radius: 24px;
                padding: 48px;
                position: relative;
                z-index: 20;
            }

            h1, h2 {
                font-family: 'Caprasimo', serif;
                color: var(--card-base-color);
                text-shadow: 2px 2px 0px var(--text-dark);
                margin-top: 32px;
                margin-bottom: 16px;
                letter-spacing: 0.5px;
            }

            h1 {
                font-size: 36px;
                margin-top: 0;
                text-align: center;
                border-bottom: 4px solid var(--text-dark);
                padding-bottom: 24px;
                margin-bottom: 32px;
            }

            h2 {
                font-size: 24px;
            }

            p {
                font-size: 15px;
                font-weight: 500;
                margin-bottom: 16px;
            }

            ul {
                margin-bottom: 16px;
                padding-left: 24px;
            }

            li {
                font-size: 15px;
                font-weight: 500;
                margin-bottom: 8px;
            }

            li::marker {
                color: var(--accent-teal);
                font-weight: bold;
                font-size: 18px;
            }

            .back-btn {
                display: block;
                width: max-content;
                margin: 0 auto 32px auto;
                background-color: var(--accent-teal);
                color: var(--text-light);
                border: 3px solid var(--text-dark);
                padding: 12px 24px;
                border-radius: 30px;
                font-family: 'Caprasimo', serif;
                font-size: 16px;
                cursor: pointer;
                box-shadow: 3px 4px 0px var(--text-dark);
                text-decoration: none;
                text-align: center;
                position: relative;
                z-index: 20;
            }

            .back-btn:active {
                transform: translate(2px, 3px);
                box-shadow: 0px 0px 0px var(--text-dark);
            }

            @media (max-width: 600px) {
                .legal-container {
                    padding: 24px;
                }
                h1 {
                    font-size: 28px;
                }
            }
        </style>
    </head>
    <body>
        <a href="javascript:history.back()" class="back-btn">← Go Back</a>
        
        <div class="legal-container">
            <h1>Terms and Conditions</h1>
            
            <p>By accessing this webpage, you are agreeing to be bound by these Terms and Conditions (“Terms") in a legally binding agreement between us (“Merchant” or “us” or “we” or “our”) and the User (“you” or “your”). Please read these Terms carefully before accessing or using the Website. If you do not agree to the Terms, you may not access the Platform.</p>
            <p>We reserve the right to update and change the Terms and Conditions by posting updates and changes to the Platform. You are advised to check the Terms and Conditions from time to time for any updates or changes that may impact you. If at any point such amendments are not acceptable to you, we advise you to cease using the Platform at such time.</p>

            <h2>Eligibility</h2>
            <p>You hereby represent and warrant that you have the right, power, and authority to agree to the Terms, to become a party to a legally binding agreement and to perform your obligations here under.</p>

            <h2>Definitions</h2>
            <ul>
                <li><strong>“Payment Instrument”</strong> includes credit card, debit card, bank account, prepaid payment instrument, Unified Payment Interface (UPI), Immediate Payment Service (IMPS) or any other methods of payments which shall be developed or added or deployed by banks and financial institutions from time to time.</li>
                <li><strong>“Platform”</strong> refers to the website or platform where the Merchant offers its products or services and where the Transaction may be initiated.</li>
                <li><strong>“Transaction”</strong> shall refer to the order or request placed by the User with the Merchant to purchase the products and/or services listed on the Platform by paying the Transaction Amount to the Merchant;</li>
                <li><strong>“Transaction Amount”</strong> shall mean the amount paid by the User in connection with a Transaction;</li>
                <li><strong>“User/Users”</strong> means any person availing the products and/or services offered on the Platform;</li>
                <li><strong>“Website”</strong> shall mean the platform or the mobile application.</li>
            </ul>

            <h2>Merchant's Rights</h2>
            <p>You agree that we may collect, store, and share the information provided by you in order to deliver the products and/or services availed by you on our Platform and/or contact you in relation to the same.</p>

            <h2>Your Responsibilities</h2>
            <p>You agree to provide us with true, complete and up-to-date information about yourself as may be required for the purpose of completing the Transactions. This information includes but is not limited to the personal details such as name, email address, phone number, delivery address, age, and gender (or any other information that we may deem necessary for us to fulfil the Transaction) as well as the accurate payment information required for the transaction.</p>

            <h2>Prohibited Actions</h2>
            <p>You may not access or use the Platform for any purpose other than that for which we make the Platform available. The Platform may not be used in connection with any commercial endeavors except those that are specifically endorsed or approved by us. As a User of the Platform, you agree not to:</p>
            <ul>
                <li>Systematically retrieve data or other content from the Platform to create or compile, directly or indirectly, a collection, compilation, database, or directory without written permission from us.</li>
                <li>Make any unauthorized use of the Platform, including collecting usernames and/or email addresses of users by electronic or other means for the purpose of sending unsolicited email, or creating user accounts by automated means or under false pretenses.</li>
                <li>Circumvent, disable, or otherwise interfere with security-related features of the Platform.</li>
                <li>Trick, defraud, or mislead us and other users, especially in any attempt to learn sensitive account information such as user passwords.</li>
                <li>Make improper use of our support services or submit false reports of abuse or misconduct.</li>
                <li>Engage in any automated use of the system, such as using scripts to send comments or messages, or using any data mining, robots, or similar data gathering and extraction tools.</li>
                <li>Interfere with, disrupt, or create an undue burden on the Platform or the networks or services connected to the Platform.</li>
                <li>Attempt to impersonate another user or person or use the username of another user.</li>
                <li>Use any information obtained from the Platform in order to harass, abuse, or harm another person.</li>
                <li>Use the Platform as part of any effort to compete with us or otherwise use the Platform and/or the Content for any revenue-generating endeavor or commercial enterprise.</li>
                <li>Decipher, decompile, disassemble, or reverse engineer any of the software comprising or in any way making up a part of the Platform.</li>
                <li>Attempt to bypass any measures of the Platform designed to prevent or restrict access to the Platform, or any portion of the Platform.</li>
                <li>Harass, annoy, intimidate, or threaten any of our employees or agents engaged in providing any portion of the Platform to you.</li>
                <li>Copy or adapt the Platform's software, including but not limited to Flash, PHP, HTML, JavaScript, or other code.</li>
                <li>Upload or transmit (or attempt to upload or to transmit) viruses, Trojan horses, or other material, including excessive use of capital letters and spamming.</li>
                <li>Disparage, tarnish, or otherwise harm, in our opinion, us and/or the Platform.</li>
                <li>Use the Platform in a manner inconsistent with any applicable laws or regulations.</li>
            </ul>

            <h2>Limitation of Liability</h2>
            <p>The User agrees that the only recourse that the User has in the event of receiving a defective product and/or deficiency in service or a product and/or service which does not match the provided description is to initiate the refund process which will be subject to the terms for refund under this agreement. We hereby expressly disclaim any liability to them for any losses.</p>
            <p>The User shall indemnify and hold harmless the Merchant and its affiliates, agents and representatives from and against any and all claims, demands, causes of action, obligations, liabilities, losses, damages, injuries, costs and expenses incurred or sustained by reason of or arising out of any breach or alleged breach of any of the terms herein by the User.</p>

            <h2>Guidelines for Reviews</h2>
            <p>We may provide you areas on the Platform to leave reviews or ratings. When posting a review, you must comply with the following criteria:</p>
            <ul>
                <li>You should have firsthand experience with the person/entity being reviewed.</li>
                <li>Your reviews should not contain offensive profanity, or abusive, racist, offensive, or hate language.</li>
                <li>Your reviews should not contain discriminatory references based on religion, race, gender, national origin, age, marital status, sexual orientation, or disability.</li>
                <li>Your reviews should not contain references to illegal activity.</li>
                <li>You should not be affiliated with competitors if posting negative reviews.</li>
                <li>You should not make any conclusions as to the legality of conduct.</li>
                <li>You may not post any false or misleading statements.</li>
                <li>You may not organize a campaign encouraging others to post reviews, whether positive or negative.</li>
            </ul>
            <p>We may accept, reject, or remove reviews in our sole discretion. We have absolutely no obligation to screen reviews or to delete reviews, even if anyone considers reviews objectionable or inaccurate. Reviews are not endorsed by us, and do not necessarily represent our opinions or the views of any of our affiliates or partners. We do not assume liability for any review or for any claims, liabilities, or losses resulting from any review. By posting a review, you hereby grant to us a perpetual, non-exclusive, worldwide, royalty-free, fully paid, assignable, and sublicensable right and license to reproduce, modify, translate, transmit by any means, display, perform and/or distribute all content relating to reviews.</p>

            <h2>Governing Laws & Dispute Resolution</h2>
            <p>Please note that these terms of use, their subject matter and their formation, are governed by the laws of India. You and we both agree that the courts of India will have exclusive jurisdiction over any dispute.</p>
            <p>Any dispute or claim arising out of or in connection with or relating to these Terms or their breach, termination or invalidity hereof (“Dispute”) shall be referred to and finally resolved by arbitration in Bengaluru in accordance with the Arbitration and Conciliation Act, 1996 for the time being in force. Within 30 (thirty) days of the issue of a notice of Dispute, the parties shall mutually agree on the appointment of a sole arbitrator. If such mutual agreement is not arrived at within the aforesaid 30 (thirty) days' period, the parties shall appoint such sole arbitrator in accordance with the Arbitration and Conciliation Act, 1996. The seat of arbitration shall be India and the arbitration proceedings shall be conducted in the English language. The parties shall keep the arbitration confidential and not disclose to any person, other than those necessary to the proceedings, any information, transcripts or award unless required to do so by law. The decision of the arbitrator shall be final and binding on all the parties hereto. The parties hereto agree that their consent for resolution of Dispute through arbitration shall not preclude or restrain either of them from seeking suitable injunctive relief in appropriate circumstances from courts in Bengaluru. The cost of arbitration shall be borne in the manner and by a party as determined by the arbitrators. In the meantime, each party shall bear its own cost for the arbitration which shall be reimbursed as per the directions in the arbitral award.</p>

            <h2>Grievance Redressal</h2>
            <p>You agree that if you have any question or complaint with regard to any product and/or service availed on our Platform, or pertaining to the Transaction, including but not limited to, double debit of Transaction Amount, fraudulent Transaction, unauthorized Transaction, refund requests, etc., you may reach out here.</p>

            <h2>Disclaimer</h2>
            <ul>
                <li>That upon initiating a Transaction, you as a User are entering into a legally binding and enforceable contract with us to purchase the products and/or services, and you shall pay the price as listed on the Platform through legitimate and legal sources of funds and through the accepted Payment Instruments.</li>
                <li>That you shall provide accurate payment details to the secure payment system for making purchase on the Platform. The information provided by you may be utilized or shared with any third party if required in relation to fraud verifications or by law, regulation or court order.</li>
                <li>We expressly disclaim all liabilities that may arise as a consequence of any unauthorized use of a User’s Payment Instrument.</li>
                <li>That all payments undertaken by you are subject to your own risk and volition. We shall not be liable for any loss or damage occurred to you arising directly or indirectly due to the decline of authorization for any Transaction, malfunction, errors and/or unscrupulous activities.</li>
                <li>If you receive a User identification code, order ID, password or any other piece of information as part of our security procedures, you must treat such information as confidential. You must not disclose it to any third party.</li>
                <li>The content on our Platform is provided for general information only. The information provided does not to amount to advice from us in any manner and should not be relied upon.</li>
                <li>Where our Platform contains links to other websites and resources provided by third parties, these links are provided for your information only. Such links should not be interpreted as approval by us of those linked websites or information you may obtain from them.</li>
                <li>This Platform includes information and materials uploaded by other Users of the Platform. You understand that such information and materials have not been verified or approved by us. The views expressed by other Users on our Platform do not represent our views or values.</li>
                <li>We do not guarantee that our Platform will be secure or free from bugs or viruses. You are responsible for configuring your information technology, computer programs and platform to access our Platform. You must use your own virus protection software.</li>
            </ul>
        </div>
    </body>
    </html>
    `;
    
    res.send(html);
});

app.get("/refund", (req, res) => {
    const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Refund & Cancellation Policy</title>
        <link href="https://fonts.googleapis.com/css2?family=Caprasimo&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,700&display=swap" rel="stylesheet">
        <style>
            * {
                box-sizing: border-box;
                margin: 0;
                padding: 0;
            }

            :root {
                --card-base-color: #FF9F1C;
                --text-light: #FFFCF2;
                --text-dark: #590D22;
                --accent-teal: #2EC4B6;
                --bg-mint: #8DE0CC;
            }

            body {
                font-family: 'DM Sans', sans-serif;
                background-color: var(--bg-mint);
                color: var(--text-dark);
                padding: 40px 20px;
                line-height: 1.6;
                position: relative;
            }

            /* Vintage Film Grain Effect */
            body::after {
                content: '';
                position: fixed;
                inset: 0;
                background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)' opacity='0.06' style='mix-blend-mode: multiply;'/%3E%3C/svg%3E");
                pointer-events: none;
                z-index: 10;
            }

            .legal-container {
                max-width: 800px;
                margin: 0 auto;
                background-color: var(--text-light);
                border: 4px solid var(--text-dark);
                box-shadow: 8px 10px 0px var(--text-dark);
                border-radius: 24px;
                padding: 48px;
                position: relative;
                z-index: 20;
            }

            h1 {
                font-family: 'Caprasimo', serif;
                color: var(--card-base-color);
                text-shadow: 2px 2px 0px var(--text-dark);
                font-size: 36px;
                margin-top: 0;
                text-align: center;
                border-bottom: 4px solid var(--text-dark);
                padding-bottom: 24px;
                margin-bottom: 32px;
                letter-spacing: 0.5px;
            }

            p {
                font-size: 15px;
                font-weight: 500;
                margin-bottom: 20px;
            }

            a.email-link {
                color: var(--accent-teal);
                font-weight: 700;
                text-decoration: none;
                border-bottom: 2px solid var(--accent-teal);
                transition: color 0.2s ease;
            }

            a.email-link:hover {
                color: var(--card-base-color);
                border-bottom-color: var(--card-base-color);
            }

            .back-btn {
                display: block;
                width: max-content;
                margin: 0 auto 32px auto;
                background-color: var(--accent-teal);
                color: var(--text-light);
                border: 3px solid var(--text-dark);
                padding: 12px 24px;
                border-radius: 30px;
                font-family: 'Caprasimo', serif;
                font-size: 16px;
                cursor: pointer;
                box-shadow: 3px 4px 0px var(--text-dark);
                text-decoration: none;
                text-align: center;
                position: relative;
                z-index: 20;
            }

            .back-btn:active {
                transform: translate(2px, 3px);
                box-shadow: 0px 0px 0px var(--text-dark);
            }

            @media (max-width: 600px) {
                .legal-container {
                    padding: 24px;
                }
                h1 {
                    font-size: 28px;
                }
            }
        </style>
    </head>
    <body>
        <a href="javascript:history.back()" class="back-btn">← Go Back</a>
        
        <div class="legal-container">
            <h1>Refund & Cancellation</h1>
            
            <p>Upon completing a Transaction, you are entering into a legally binding and enforceable agreement with us to purchase the product and/or service. After this point the User may cancel the Transaction unless it has been specifically provided for on the Platform. In which case, the cancellation will be subject to the terms mentioned on the Platform. We shall retain the discretion in approving any cancellation requests and we may ask for additional details before approving any requests.</p>
            
            <p>Once you have received the product and/or service, the only event where you can request for a replacement or a return and a refund is if the product and/or service does not match the description as mentioned on the Platform.</p>
            
            <p>Any request for refund must be submitted within three days from the date of the Transaction or such number of days prescribed on the Platform, which shall in no event be less than three days. A User may submit a claim for a refund for a purchase made, by raising a ticket here or contacting us on <a class="email-link" href="mailto:seller+561eb3132cf14ac8a2cb67cd01619598@instamojo.com">seller+561eb3132cf14ac8a2cb67cd01619598@instamojo.com</a> and providing a clear and specific reason for the refund request, including the exact terms that have been violated, along with any proof, if required.</p>
            
            <p>Whether a refund will be provided will be determined by us, and we may ask for additional details before approving any requests.</p>
        </div>
    </body>
    </html>
    `;
    
    res.send(html);
});

// ==========================================
// 1. PRIVACY POLICY ROUTE
// ==========================================
app.get("/privacy", (req, res) => {
    const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Privacy Policy</title>
        <link href="https://fonts.googleapis.com/css2?family=Caprasimo&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,700&display=swap" rel="stylesheet">
        <style>
            * { box-sizing: border-box; margin: 0; padding: 0; }
            :root { --card-base-color: #FF9F1C; --text-light: #FFFCF2; --text-dark: #590D22; --accent-teal: #2EC4B6; --bg-mint: #8DE0CC; }
            body { font-family: 'DM Sans', sans-serif; background-color: var(--bg-mint); color: var(--text-dark); padding: 40px 20px; line-height: 1.6; position: relative; }
            body::after { content: ''; position: fixed; inset: 0; background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)' opacity='0.06' style='mix-blend-mode: multiply;'/%3E%3C/svg%3E"); pointer-events: none; z-index: 10; }
            .legal-container { max-width: 800px; margin: 0 auto; background-color: var(--text-light); border: 4px solid var(--text-dark); box-shadow: 8px 10px 0px var(--text-dark); border-radius: 24px; padding: 48px; position: relative; z-index: 20; }
            h1, h2 { font-family: 'Caprasimo', serif; color: var(--card-base-color); text-shadow: 2px 2px 0px var(--text-dark); letter-spacing: 0.5px; }
            h1 { font-size: 36px; margin-top: 0; text-align: center; border-bottom: 4px solid var(--text-dark); padding-bottom: 24px; margin-bottom: 32px; }
            h2 { font-size: 24px; margin-top: 32px; margin-bottom: 16px; }
            p { font-size: 15px; font-weight: 500; margin-bottom: 16px; }
            ul { margin-bottom: 16px; padding-left: 24px; }
            li { font-size: 15px; font-weight: 500; margin-bottom: 8px; }
            li::marker { color: var(--accent-teal); font-weight: bold; font-size: 18px; }
            .back-btn { display: block; width: max-content; margin: 0 auto 32px auto; background-color: var(--accent-teal); color: var(--text-light); border: 3px solid var(--text-dark); padding: 12px 24px; border-radius: 30px; font-family: 'Caprasimo', serif; font-size: 16px; cursor: pointer; box-shadow: 3px 4px 0px var(--text-dark); text-decoration: none; text-align: center; position: relative; z-index: 20; }
            .back-btn:active { transform: translate(2px, 3px); box-shadow: 0px 0px 0px var(--text-dark); }
            @media (max-width: 600px) { .legal-container { padding: 24px; } h1 { font-size: 28px; } }
        </style>
    </head>
    <body>
        <a href="javascript:history.back()" class="back-btn">← Go Back</a>
        <div class="legal-container">
            <h1>Privacy Policy</h1>
            <p>This Privacy Policy describes how your personal information is collected, used, and shared when you visit or make a purchase from our VIP Priority Chat service (the "Site").</p>
            
            <h2>Personal Information We Collect</h2>
            <p>When you visit the Site, we automatically collect certain information about your device, including information about your web browser, IP address, time zone, and some of the cookies that are installed on your device. Additionally, when you make a purchase or attempt to make a purchase through the Site, we collect certain information from you, including your Instagram Username/ID, billing address, and payment information (processed securely via Cashfree).</p>
            
            <h2>How Do We Use Your Personal Information?</h2>
            <p>We use the Order Information that we collect generally to fulfill any orders placed through the Site (including processing your payment information and unlocking your priority chat access). Additionally, we use this Order Information to:</p>
            <ul>
                <li>Communicate with you via Instagram Direct Messages.</li>
                <li>Screen our orders for potential risk or fraud.</li>
            </ul>
            
            <h2>Sharing Your Personal Information</h2>
            <p>We share your Personal Information with third parties to help us use your Personal Information, as described above. We use Cashfree as our payment gateway; you can read more about how Cashfree uses your Personal Information here: https://www.cashfree.com/privacypolicy/.</p>
            <p>Finally, we may also share your Personal Information to comply with applicable laws and regulations, to respond to a subpoena, search warrant or other lawful request for information we receive, or to otherwise protect our rights.</p>
            
            <h2>Data Retention</h2>
            <p>When you place an order through the Site, we will maintain your Order Information for our records unless and until you ask us to delete this information.</p>
            
            <h2>Changes</h2>
            <p>We may update this privacy policy from time to time in order to reflect, for example, changes to our practices or for other operational, legal or regulatory reasons.</p>
        </div>
    </body>
    </html>
    `;
    res.send(html);
});

// ==========================================
// 2. CONTACT US ROUTE
// ==========================================
app.get("/contact", (req, res) => {
    const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Contact Details</title>
        <link href="https://fonts.googleapis.com/css2?family=Caprasimo&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,700&display=swap" rel="stylesheet">
        <style>
            * { box-sizing: border-box; margin: 0; padding: 0; }
            :root { --card-base-color: #FF9F1C; --text-light: #FFFCF2; --text-dark: #590D22; --accent-teal: #2EC4B6; --bg-mint: #8DE0CC; }
            body { font-family: 'DM Sans', sans-serif; background-color: var(--bg-mint); color: var(--text-dark); padding: 40px 20px; line-height: 1.6; position: relative; }
            body::after { content: ''; position: fixed; inset: 0; background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)' opacity='0.06' style='mix-blend-mode: multiply;'/%3E%3C/svg%3E"); pointer-events: none; z-index: 10; }
            .legal-container { max-width: 650px; margin: 0 auto; background-color: var(--text-light); border: 4px solid var(--text-dark); box-shadow: 8px 10px 0px var(--text-dark); border-radius: 24px; padding: 48px; position: relative; z-index: 20; text-align: center; }
            h1 { font-family: 'Caprasimo', serif; color: var(--card-base-color); text-shadow: 2px 2px 0px var(--text-dark); letter-spacing: 0.5px; font-size: 36px; margin-top: 0; border-bottom: 4px solid var(--text-dark); padding-bottom: 24px; margin-bottom: 24px; }
            
            p.intro-text { font-size: 16px; font-weight: 500; margin-bottom: 16px; text-align: left; }
            
            .info-block { margin-top: 24px; margin-bottom: 24px; text-align: left; background-color: rgba(46, 196, 182, 0.1); padding: 24px; border-radius: 16px; border: 2px dashed var(--text-dark); }
            h3 { font-family: 'Caprasimo', serif; color: var(--text-dark); font-size: 20px; margin-bottom: 12px; }
            p { font-size: 15px; font-weight: 500; margin-bottom: 0; }
            
            ul { margin-top: 12px; margin-bottom: 0; padding-left: 24px; text-align: left; }
            li { font-size: 15px; font-weight: 500; margin-bottom: 8px; }
            li::marker { color: var(--accent-teal); font-weight: bold; font-size: 18px; }

            a.email-link { color: var(--accent-teal); font-weight: 700; text-decoration: none; border-bottom: 2px solid var(--accent-teal); transition: color 0.2s ease; display: inline-block; margin-top: 8px; font-size: 16px; }
            a.email-link:hover { color: var(--card-base-color); border-bottom-color: var(--card-base-color); }
            
            .back-btn { display: block; width: max-content; margin: 0 auto 32px auto; background-color: var(--accent-teal); color: var(--text-light); border: 3px solid var(--text-dark); padding: 12px 24px; border-radius: 30px; font-family: 'Caprasimo', serif; font-size: 16px; cursor: pointer; box-shadow: 3px 4px 0px var(--text-dark); text-decoration: none; position: relative; z-index: 20; }
            .back-btn:active { transform: translate(2px, 3px); box-shadow: 0px 0px 0px var(--text-dark); }
            
            @media (max-width: 600px) { .legal-container { padding: 24px; } h1 { font-size: 28px; } }
        </style>
    </head>
    <body>
        <a href="javascript:history.back()" class="back-btn">← Go Back</a>
        <div class="legal-container">
            <h1>Contact Details</h1>
            
            <p class="intro-text">Got a question, concern, or need assistance with your transaction? We are here to help!</p>
            <p class="intro-text">Whether you need help tracking your exclusive image vault allocation, have questions about your scheduled talk timing, or are experiencing technical difficulties, please don't hesitate to reach out.</p>

            <div class="info-block">
                <h3>Direct Communication Terminal</h3>
                <p>For all inquiries, please email us directly at:<br>
                <a class="email-link" href="mailto:siyashah.contact@gmail.com">siyashah.contact@gmail.com</a></p>
            </div>

            <div class="info-block">
                <h3>Response Times</h3>
                <p>Our support team monitors this inbox closely. We strive to reply to all non-urgent queries within 24-48 business hours. If you are reaching out regarding a payment failure or an immediate scheduling conflict, please use the subject line <strong>"URGENT: [Your Ticket ID]"</strong> to ensure priority routing.</p>
            </div>

            <div class="info-block">
                <h3>What to Include</h3>
                <p>To help us serve you faster, please include the following in your email:</p>
                <ul>
                    <li>The exact name and email address used during the checkout process.</li>
                    <li>Your unique Ticket ID (e.g., SEC-MNL-XXXXXX) if you received one.</li>
                    <li>A clear description of your issue or request.</li>
                    <li>Any relevant screenshots of error messages or payment confirmations.</li>
                </ul>
            </div>
            
        </div>
    </body>
    </html>
    `;
    res.send(html);
});


app.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});
