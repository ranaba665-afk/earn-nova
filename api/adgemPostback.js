import admin from "firebase-admin";
import crypto from "crypto";

function getFirebaseAdmin() {
  if (admin.apps.length) {
    return admin.app();
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error("Firebase Admin environment variables are missing.");
  }

  return admin.initializeApp({
    credential: admin.credential.cert({
      projectId,
      clientEmail,
      privateKey: privateKey.replace(/\\n/g, "\n"),
    }),
  });
}

export default async function handler(req, res) {
  try {
    const firebaseApp = getFirebaseAdmin();
    const db = admin.firestore();

    const query = req.query;
    const verifier = query.verifier;
    const playerId = query.player_id;
    const requestId = query.request_id;
    const offerName = query.offer_name || "AdGem Offer";
    const payoutUsd = Number(query.payout || 0);
    const presetAmount = Number(query.amount || 0);

    if (!verifier || !playerId || !requestId) {
      console.error("Missing required postback params", query);
      return res.status(400).send("Missing required parameters");
    }

    // ============ REVENUE SHARE CALCULATION ============
    // We pay the user a share of what AdGem actually pays us for
    // the conversion (the {payout} macro, in USD) rather than a
    // flat preset reward. Tune these via Vercel env vars any time
    // without touching code.
    const REVENUE_SHARE_PERCENT =
      Number(process.env.REVENUE_SHARE_PERCENT || 0.40); // user gets 40%
    const USD_TO_INR_RATE =
      Number(process.env.USD_TO_INR_RATE || 88); // approximate, update as needed
    const POINTS_PER_RUPEE = 10000; // matches the site's 10,000 pts = ₹1 rate

    let amount;

    if (payoutUsd > 0) {
      const userShareInr =
        payoutUsd * USD_TO_INR_RATE * REVENUE_SHARE_PERCENT;
      amount = Math.round(userShareInr * POINTS_PER_RUPEE);
    } else if (presetAmount > 0) {
      // Fallback for the rare offer that doesn't report a payout value
      console.warn("No payout macro received, falling back to amount", {
        requestId,
        playerId,
      });
      amount = presetAmount;
    } else {
      console.error("Missing both payout and amount", query);
      return res.status(400).send("Missing payout/amount");
    }

    if (amount <= 0) {
      console.error("Computed non-positive amount", { requestId, amount });
      return res.status(400).send("Invalid computed amount");
    }

    // Rebuild the full request URL, then strip the verifier param,
    // exactly as AdGem instructs, to recompute the expected hash.
    const protocol = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const fullUrl = `${protocol}://${host}${req.url}`;
    const urlNoVerifier = fullUrl
      .replace(/([&?])verifier=[^&]*/, "$1")
      .replace(/[&?]$/, "");

    const expectedHash = crypto
      .createHmac("sha256", process.env.ADGEM_POSTBACK_KEY)
      .update(urlNoVerifier)
      .digest("hex");

    if (expectedHash !== verifier) {
      console.error("Verifier mismatch — possible spoofed postback", {
        requestId,
        playerId,
      });
      return res.status(403).send("Invalid verifier");
    }

    const postbackRef = db.collection("adgemPostbacks").doc(requestId);
    const usersQuery = await db
      .collection("users")
      .where("adgemPlayerId", "==", playerId)
      .limit(1)
      .get();

    if (usersQuery.empty) {
      console.error("Postback for unknown player_id", playerId);
      return res.status(404).send("User not found");
    }

    const userRef = usersQuery.docs[0].ref;

    await db.runTransaction(async (tx) => {
      const postbackDoc = await tx.get(postbackRef);
      if (postbackDoc.exists) {
        throw new Error("DUPLICATE_REQUEST_ID");
      }

      const userDoc = await tx.get(userRef);
      if (!userDoc.exists) {
        throw new Error("USER_NOT_FOUND");
      }

      const currentPoints = Number(userDoc.data().points || 0);
      const newPoints = currentPoints + amount;

      tx.update(userRef, { points: newPoints });

      tx.set(postbackRef, {
        playerId,
        amount,
        payoutUsd,
        offerName,
        processedAt: admin.firestore.FieldValue.serverTimestamp(),
        raw: query,
      });

      const historyRef = userRef.collection("history").doc();
      tx.set(historyRef, {
        points: amount,
        type: "adgem_offer",
        label: offerName,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    // AdGem expects a 200 response to mark the postback as delivered.
    return res.status(200).send("1");
  } catch (err) {
    if (err.message === "DUPLICATE_REQUEST_ID") {
      return res.status(200).send("1");
    }
    if (err.message === "USER_NOT_FOUND") {
      console.error("Postback for unknown player_id", req.query.player_id);
      return res.status(404).send("User not found");
    }
    console.error("Postback processing error:", err);
    return res.status(500).send("Internal error");
  }
}
