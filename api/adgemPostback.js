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
