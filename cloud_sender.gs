/**
 * 🚀 JOB APPLICATION CLOUD SENDER (GSoC / JobPulse)
 * This script will run on Google's servers even if your laptop is closed.
 * It will send 5 emails every 1 minute starting at 9:00 AM tomorrow (April 8th).
 */

const START_TIME = "2026-04-08 09:00:00"; // Trigger at 9AM Tomorrow
const BATCH_SIZE = 5;
const SIGNATURE_ID = "+91 7004544142"; // Distinctive signature we drafted

function scheduleAllDrafts() {
  console.log("🚀 Initializing Cloud Sender for April 8th, 09:00 AM...");
  
  // Clean old triggers
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    ScriptApp.deleteTrigger(triggers[i]);
  }

  // Create start trigger
  const startDate = new Date(START_TIME);
  ScriptApp.newTrigger("sendNextBatch")
    .timeBased()
    .at(startDate)
    .create();

  console.log("✅ Triggered scheduled at " + startDate.toLocaleString());
  console.log("⚠️ DO NOT CLOSE this tab until you see '✅ Triggered scheduled'.");
}

function sendNextBatch() {
  const drafts = GmailApp.getDrafts();
  let pending = [];

  // Filter drafts that contain your phone number (our signature)
  for (let i = 0; i < drafts.length; i++) {
    const rawBody = drafts[i].getMessage().getPlainBody();
    if (rawBody.indexOf(SIGNATURE_ID) !== -1) {
      pending.push(drafts[i]);
    }
  }

  console.log("📦 Found " + pending.length + " pending drafts.");

  if (pending.length > 0) {
    const batch = pending.slice(0, BATCH_SIZE);
    for (let j = 0; j < batch.length; j++) {
      console.log("📤 Sending: " + batch[j].getMessage().getSubject());
      batch[j].send();
    }

    // Schedule next batch in 1 minute
    if (pending.length > BATCH_SIZE) {
      console.log("⏳ Batch done. Scheduling next in 1 minute...");
      ScriptApp.newTrigger("sendNextBatch")
        .timeBased()
        .after(60000) // 1 min buffer
        .create();
    } else {
      console.log("🎉 ALL EMAILS SENT SUCCESSFULLY!");
    }
  }

  // Self-cleanup: Delete current trigger
  const triggers = ScriptApp.getProjectTriggers();
  for (let k = 0; k < triggers.length; k++) {
    const handler = triggers[k].getHandlerFunction();
    if (handler === "sendNextBatch") {
      ScriptApp.deleteTrigger(triggers[k]);
    }
  }
}
