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
      privateKey: privateKey.replace(/\\n/g, "\n")
    })
  });
}


export default async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed"
    });
  }


  try {

    const firebaseApp = getFirebaseAdmin();

    const db = admin.firestore();
    const auth = admin.auth();


    // =========================
    // CHECK AUTHORIZATION
    // =========================

    const authorization =
      req.headers.authorization || "";

    if (!authorization.startsWith("Bearer ")) {

      return res.status(401).json({
        success: false,
        error: "Authentication required"
      });

    }


    const idToken =
      authorization.substring(7);


    // Verify Firebase login token
    const decodedToken =
      await auth.verifyIdToken(idToken);


    const uid =
      decodedToken.uid;


    // =========================
    // REQUEST DATA
    // =========================

    const {
      taskId,
      claimId,
      dateString
    } = req.body || {};


    if (!taskId || !claimId) {

      return res.status(400).json({
        success: false,
        error: "taskId and claimId are required"
      });

    }


    // =========================
    // SERVER CONTROLLED TASKS
    // =========================

    const TASKS = {

      demo_watch_ad: {
        title: "Watch Ad",
        points: 100,
        icon: "📺"
      },

      demo_quick_task: {
        title: "Quick Task",
        points: 500,
        icon: "⚡"
      },

      demo_quiz: {
        title: "Mini Quiz",
        points: 300,
        icon: "🧠"
      },

      daily_bonus: {
        title: "Daily Bonus",
        points: 500,
        icon: "🎁"
      },

      streak_3: {
        title: "3-Day Streak",
        points: 500,
        icon: "🔥"
      },

      streak_7: {
        title: "7-Day Streak",
        points: 1000,
        icon: "🔥"
      },

      streak_15: {
        title: "15-Day Streak",
        points: 2500,
        icon: "🔥"
      },

      streak_30: {
        title: "30-Day Streak",
        points: 10000,
        icon: "🔥"
      },

      social_subscribe: {
        title: "YouTube + Telegram Subscribe",
        points: 10000,
        icon: "📢"
      }

    };


    const task =
      TASKS[taskId];


    if (!task) {

      return res.status(400).json({
        success: false,
        error: "Invalid task"
      });

    }


    // =========================
    // DOCUMENT REFERENCES
    // =========================

    const userRef =
      db.collection("users").doc(uid);

    const claimRef =
      userRef
        .collection("claims")
        .doc(claimId);

    const historyRef =
      userRef
        .collection("history")
        .doc();


    // =========================
    // ATOMIC TRANSACTION
    // =========================

    await db.runTransaction(async transaction => {

      const userSnap =
        await transaction.get(userRef);

      if (!userSnap.exists) {

        throw new Error("User profile not found.");

      }


      const claimSnap =
        await transaction.get(claimRef);


      // Prevent duplicate reward
      // (for daily_bonus, claimId is date-based, so this also
      // naturally enforces "once per day")
      if (claimSnap.exists) {

        throw new Error(
          taskId === "daily_bonus"
            ? "Daily bonus already claimed."
            : taskId === "social_subscribe"
            ? "Social subscribe bonus already claimed."
            : "This earning has already been claimed."
        );

      }


      const user =
        userSnap.data();


      const currentPoints =
        Number(user.points || 0);

      const currentTodayPoints =
        Number(user.todayPoints || 0);

      const currentTasks =
        Number(user.totalTasks || 0);


      const newPoints =
        currentPoints + task.points;

      const newTodayPoints =
        currentTodayPoints + task.points;

      const newTotalTasks =
        currentTasks + 1;


      const userUpdate = {

        points: newPoints,

        todayPoints: newTodayPoints,

        totalTasks: newTotalTasks

      };

      if (taskId === "daily_bonus" && dateString) {
        userUpdate.lastBonusDate = dateString;
      }

      if (taskId === "social_subscribe") {
        userUpdate.socialSubscribeClaimed = true;
      }


      // Update user
      transaction.update(userRef, userUpdate);


      // Save claim
      transaction.set(claimRef, {

        taskId: taskId,

        points: task.points,

        createdAt:
          admin.firestore.FieldValue.serverTimestamp()

      });


      // Save history
      transaction.set(historyRef, {

        title: task.title,

        points: task.points,

        icon: task.icon,

        taskId: taskId,

        createdAt:
          admin.firestore.FieldValue.serverTimestamp()

      });

    });


    return res.status(200).json({

      success: true,

      points: task.points,

      message:
        `You earned ${task.points} points.`

    });


  } catch (error) {

    console.error(
      "Earn API error:",
      error
    );


    if (
      error.message ===
      "This earning has already been claimed." ||
      error.message ===
      "Daily bonus already claimed." ||
      error.message ===
      "Social subscribe bonus already claimed."
    ) {

      return res.status(409).json({
        success: false,
        error: error.message
      });

    }


    return res.status(500).json({

      success: false,

      error:
        "Unable to process earning."

    });

  }

}
