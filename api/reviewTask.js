import admin from "firebase-admin";

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
    getFirebaseAdmin();
    const db = admin.firestore();

    const { secret, uid, taskId, action } = req.query;

    if (!secret || secret !== process.env.ADMIN_SECRET) {
      return res.status(403).send("Forbidden");
    }

    if (!uid || !taskId || !["approve", "reject"].includes(action)) {
      return res
        .status(400)
        .send("Required: uid, taskId, action=approve|reject");
    }

    const userRef = db.collection("users").doc(uid);
    const claimRef = userRef.collection("customTaskClaims").doc(taskId);

    const result = await db.runTransaction(async (tx) => {
      const claimSnap = await tx.get(claimRef);

      if (!claimSnap.exists) {
        throw new Error("CLAIM_NOT_FOUND");
      }

      const claim = claimSnap.data();

      if (claim.status !== "pending") {
        throw new Error("ALREADY_" + claim.status.toUpperCase());
      }

      if (action === "reject") {
        tx.update(claimRef, {
          status: "rejected",
          reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        return { rejected: true };
      }

      // action === "approve"
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) {
        throw new Error("USER_NOT_FOUND");
      }

      const currentPoints = Number(userSnap.data().points || 0);
      const currentTodayPoints = Number(userSnap.data().todayPoints || 0);
      const currentTasks = Number(userSnap.data().totalTasks || 0);
      const points = Number(claim.points || 0);

      tx.update(userRef, {
        points: currentPoints + points,
        todayPoints: currentTodayPoints + points,
        totalTasks: currentTasks + 1,
      });

      tx.update(claimRef, {
        status: "approved",
        reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      const historyRef = userRef.collection("history").doc();
      tx.set(historyRef, {
        title: claim.title,
        points,
        icon: "✅",
        type: "custom_task_manual",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return { approved: true, points };
    });

    return res.status(200).send(`OK: ${JSON.stringify(result)}`);
  } catch (err) {
    if (err.message === "CLAIM_NOT_FOUND") {
      return res.status(404).send("Claim not found");
    }
    if (err.message?.startsWith("ALREADY_")) {
      return res.status(409).send(err.message);
    }
    if (err.message === "USER_NOT_FOUND") {
      return res.status(404).send("User not found");
    }
    console.error("reviewTask error:", err);
    return res.status(500).send("Internal error");
  }
}
