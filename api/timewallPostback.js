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

// TimeWall's known outbound IPs, for optional defense-in-depth.
// The hash check below is the real security boundary.
const TIMEWALL_IPS = ["18.156.132.55", "51.81.120.73", "142.111.248.18"];

export default async function handler(req, res) {
  try {
    const firebaseApp = getFirebaseAdmin();
    const db = admin.firestore();

    const query = req.query;
    const userId = query.userid;
    const txId = query.txid;
    const revenue = query.revenue; // raw string, exactly as received — do not reformat
    const currencyAmount = Number(query.currency || 0); // already-converted Points
    const hash = query.hash;
    const offerName = query.offername || "TimeWall Offer";
    const type = query.type || "credit"; // TimeWall sends type=credit or type=chargeback (or similar)

    if (!userId || !txId || !revenue || !currencyAmount || !hash) {
      console.error("Missing required TimeWall postback params", query);
      return res.status(400).send("Missing required parameters");
    }

    // ============ VERIFY HASH ============
    // TimeWall's formula: hash("sha256", userID . revenue . SecretKey)
    // Use the revenue value exactly as received (raw string).
    const expectedHash = crypto
      .createHash("sha256")
      .update(userId + revenue + process.env.TIMEWALL_SECRET_KEY)
      .digest("hex");

    if (expectedHash !== hash) {
      console.error("TimeWall hash mismatch — possible spoofed postback", {
        txId,
        userId,
      });
      return res.status(403).send("Invalid hash");
    }

    // Chargebacks / reversals: log but don't credit points.
    // (Extend this if TimeWall sends a distinct type for reversals —
    // confirm the exact value with their support before relying on it.)
    if (type && type.toLowerCase().includes("chargeback")) {
      console.warn("TimeWall chargeback received, not crediting", {
        txId,
        userId,
      });
      return res.status(200).send("OK");
    }

    const postbackRef = db.collection("timewallPostbacks").doc(txId);
    const userRef = db.collection("users").doc(userId);

    await db.runTransaction(async (tx) => {
      const postbackDoc = await tx.get(postbackRef);
      if (postbackDoc.exists) {
        throw new Error("DUPLICATE_TX_ID");
      }

      const userDoc = await tx.get(userRef);
      if (!userDoc.exists) {
        throw new Error("USER_NOT_FOUND");
      }

      const currentPoints = Number(userDoc.data().points || 0);
      const newPoints = currentPoints + currencyAmount;

      tx.update(userRef, { points: newPoints });

      tx.set(postbackRef, {
        userId,
        amount: currencyAmount,
        revenueUsd: revenue,
        offerName,
        processedAt: admin.firestore.FieldValue.serverTimestamp(),
        raw: query,
      });

      const historyRef = userRef.collection("history").doc();
      tx.set(historyRef, {
        points: currencyAmount,
        type: "timewall_offer",
        label: offerName,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    // TimeWall just needs a 200 OK to mark the postback as delivered.
    return res.status(200).send("OK");
  } catch (err) {
    if (err.message === "DUPLICATE_TX_ID") {
      return res.status(200).send("OK");
    }
    if (err.message === "USER_NOT_FOUND") {
      console.error("TimeWall postback for unknown userid", req.query.userid);
      return res.status(404).send("User not found");
    }
    console.error("TimeWall postback processing error:", err);
    return res.status(500).send("Internal error");
  }
}
