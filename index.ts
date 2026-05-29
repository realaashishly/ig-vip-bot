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
      order_id: `order_${userId}_${Date.now()}`, // Attach the IG ID to the order!
      customer_details: {
        customer_id: userId,
        // Cashfree requires a phone number. If you don't have it from IG, use a dummy one.
        customer_phone: "9999999999",
        customer_name: "Instagram User",
      },
      order_meta: {
        // Where Cashfree sends the user after successful payment
        return_url: `https://yourwebsite.com/success?order_id={order_id}`,
      },
    };

    const response = await cashfree.PGCreateOrder(request);

    // Send the Cashfree payment session ID back to your website to open the checkout
    res.json({ payment_session_id: response.data.payment_session_id });
  } catch (error) {}
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

app.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});
