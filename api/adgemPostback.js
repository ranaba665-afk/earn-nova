const admin = require("firebase-admin");
const crypto = require("crypto");

// Initialize firebase-admin once (Vercel reuses the process between calls)
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      // Vercel env vars store newlines as literal \n — convert them back
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    }),
  });
}

const db = admin.firestore();

module.exports = async (req, res) => {
  try {
    const query = req.query;
    const verifier = query.verifier;
    const playerId = query.player_id;
    const amount = Number(query.amount || 0);
    const requestId = query.request_id;
    const offerName = query.offer_name || "AdGem Offer";

    if (!verifier || !playerId || !requestId || !amount) {
      console.error("Missing required postback params", query);
      return res.status(400).send("Missing required parameters");
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
    const userRef = db.collection("users").doc(playerId);

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
};
