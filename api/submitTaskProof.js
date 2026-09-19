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
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  try {
    getFirebaseAdmin();
    const db = admin.firestore();
    const auth = admin.auth();

    const authorization = req.headers.authorization || "";
    if (!authorization.startsWith("Bearer ")) {
      return res.status(401).json({ success: false, error: "Authentication required" });
    }

    const idToken = authorization.substring(7);
    const decodedToken = await auth.verifyIdToken(idToken);
    const uid = decodedToken.uid;

    const { customTaskId, proof } = req.body || {};

    if (!customTaskId || !proof || !proof.trim()) {
      return res.status(400).json({
        success: false,
        error: "customTaskId and proof are required",
      });
    }

    const taskRef = db.collection("customTasks").doc(customTaskId);
    const taskSnap = await taskRef.get();

    if (!taskSnap.exists || !taskSnap.data().active) {
      return res.status(404).json({ success: false, error: "Task not found" });
    }

    const taskData = taskSnap.data();

    if (taskData.verificationType !== "manual") {
      return res.status(400).json({
        success: false,
        error: "This task does not require manual review",
      });
    }

    const claimRef = db
      .collection("users")
      .doc(uid)
      .collection("customTaskClaims")
      .doc(customTaskId);

    const existing = await claimRef.get();
    if (existing.exists) {
      return res.status(409).json({
        success: false,
        error: `This task is already ${existing.data().status}.`,
      });
    }

    await claimRef.set({
      taskId: customTaskId,
      title: taskData.title,
      points: Number(taskData.points || 0),
      proof: proof.trim(),
      status: "pending",
      submittedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.status(200).json({
      success: true,
      message: "Submitted for review. You'll be credited once approved.",
    });
  } catch (err) {
    console.error("submitTaskProof error:", err);
    return res.status(500).json({ success: false, error: "Unable to submit proof." });
  }
}
