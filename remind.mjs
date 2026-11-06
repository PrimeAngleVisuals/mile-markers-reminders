// Mile Markers reminder job. Runs every 15 minutes on GitHub Actions.
// Reads the app's Firebase database and sends phone notifications for:
//   - game plan steps when they're due
//   - bills the morning before they're due, and the morning they're due if still unpaid
//   - paydays, the morning of
// Each reminder is sent once; sent ones are recorded in the "notified" collection.
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";

const SITE = process.env.SITE_URL || "https://road-to-jan-yaya.netlify.app/";
const DRY = process.argv.includes("--dry");
const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
if (!sa.project_id){ console.error("FIREBASE_SERVICE_ACCOUNT secret is missing or not valid JSON."); process.exit(1); }
initializeApp({ credential: cert(sa) });
const db = getFirestore();

/* ---- dates (the job runs with TZ=America/New_York, so local time is Eastern) ---- */
const pad = n => (n < 10 ? "0" : "") + n;
const ymd = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
const pd = s => { const p = String(s).split("-").map(Number); return new Date(p[0], (p[1] || 1) - 1, p[2] || 1); };
const diffDays = (a, b) => Math.round((pd(b) - pd(a)) / 86400000);
const addDays = (s, n) => { const d = pd(s); d.setDate(d.getDate() + n); return ymd(d); };
const clampDate = (y, m, d) => { const f = new Date(y, m - 1, 1); const yy = f.getFullYear(), mm = f.getMonth() + 1; const dim = new Date(yy, mm, 0).getDate(); return ymd(new Date(yy, mm - 1, Math.min(d, dim))); };
const at = (day, h, m = 0) => { const d = pd(day); d.setHours(h, m, 0, 0); return d.getTime(); };
const num = (v, d) => { const n = Number(v); return isFinite(n) ? n : d; };
const money = n => "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: Number(n) % 1 ? 2 : 0, maximumFractionDigits: 2 });
const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

/* ---- schedules: same rules as the app ---- */
let START = "2026-10-30";
function anchorOf(b){
  if (b.next) return b.next;
  const D = Number(b.due); if (!D) return null;
  const y = +START.slice(0, 4), m = +START.slice(5, 7), t = clampDate(y, m, D);
  return t >= START ? t : clampDate(y, m + 1, D);
}
function stepDate(a, f, k){
  if (f === "weekly") return addDays(a, 7 * k);
  if (f === "biweekly") return addDays(a, 14 * k);
  if (f === "yearly") return clampDate(+a.slice(0, 4) + k, +a.slice(5, 7), +a.slice(8, 10));
  if (f === "once") return k === 0 ? a : null;
  return clampDate(+a.slice(0, 4), +a.slice(5, 7) + k, +a.slice(8, 10));
}
const isPlan = b => num(b.payments, 0) > 0 && (b.freq || "monthly") !== "once";
const lastDateOf = b => { if (!isPlan(b)) return null; const a = anchorOf(b); return a ? stepDate(a, b.freq || "monthly", num(b.payments, 0) - 1) : null; };
function nextOnOrAfter(b, day){
  const a = anchorOf(b); if (!a) return null;
  const f = b.freq || "monthly";
  let next;
  if (day <= a) next = a;
  else if (f === "once") next = null;
  else if (f === "weekly" || f === "biweekly"){ const step = f === "weekly" ? 7 : 14, k = Math.ceil(diffDays(a, day) / step); next = addDays(a, k * step); }
  else if (f === "yearly"){ const ty = clampDate(+day.slice(0, 4), +a.slice(5, 7), +a.slice(8, 10)); next = ty >= day ? ty : clampDate(+day.slice(0, 4) + 1, +a.slice(5, 7), +a.slice(8, 10)); }
  else { const D = +a.slice(8, 10), tm = clampDate(+day.slice(0, 4), +day.slice(5, 7), D); next = tm >= day ? tm : clampDate(+day.slice(0, 4), +day.slice(5, 7) + 1, D); }
  const L = lastDateOf(b);
  if (next && L && next > L) next = null;
  return next;
}
const paidKeys = b => Array.isArray(b.paidKeys) ? b.paidKeys : [];
const isPaid = (b, key) => paidKeys(b).includes(key);
const planDone = b => isPlan(b) && num(b.paidCount, paidKeys(b).length) >= num(b.payments, 0);

/* ---- load ---- */
const rows = snap => snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
const [settingsDoc, billsS, incomeS, tasksS, devicesS] = await Promise.all([
  db.doc("settings/main").get(), db.collection("bills").get(), db.collection("income").get(), db.collection("tasks").get(), db.collection("devices").get()
]);
if (settingsDoc.exists && settingsDoc.data().startDate) START = settingsDoc.data().startDate;
const bills = rows(billsS), income = rows(incomeS), tasks = rows(tasksS), devices = rows(devicesS);
const now = Date.now(), today = ymd(new Date(now));

/* ---- what is due ---- */
const due = [];
for (const t of tasks){
  if (t.done || !t.due) continue;
  const when = num(t.remindAt, 0) || at(t.due, 9);
  due.push({ key: "task-" + t.id + "-" + when, when, window: 36, who: t.who || "split", title: "Game plan", body: t.text, link: SITE + "#plan" });
}
for (const b of bills){
  const amt = num(b.amt, 0);
  if (!(amt > 0) || planDone(b)) continue;
  for (const day of [addDays(today, -1), today, addDays(today, 1)]){
    const d = nextOnOrAfter(b, day);
    if (d !== day || isPaid(b, d)) continue;
    const label = b.name + " (" + money(amt) + ")";
    due.push({ key: "bill-" + b.id + "-" + d + "-before", when: at(addDays(d, -1), 9), window: 12, who: b.who || "split", title: "Due tomorrow", body: label + " is due tomorrow, " + MON[pd(d).getMonth()] + " " + pd(d).getDate() + ".", link: SITE + "#month" });
    due.push({ key: "bill-" + b.id + "-" + d + "-day", when: at(d, 9), window: 12, who: b.who || "split", title: "Due today", body: label + " is due today. Tick it in Mile Markers once it’s paid.", link: SITE + "#month" });
  }
}
for (const i of income){
  for (const day of [addDays(today, -1), today]){
    const d = nextOnOrAfter(i, day);
    if (d !== day || isPaid(i, d)) continue;
    due.push({ key: "pay-" + i.id + "-" + d, when: at(d, 9), window: 12, who: i.who || "split", title: "Payday", body: (i.name || "Paycheck") + (num(i.amt, 0) > 0 ? " (" + money(i.amt) + ")" : "") + ". Tap Got paid when it lands.", link: SITE + "#month" });
  }
}
for (const dv of devices){
  if (num(dv.test, 0) > num(dv.testSent, 0)) due.push({ key: null, device: dv, when: now, window: 24, who: dv.who, title: "Reminders are working", body: "This phone will get alerts for steps, bills and paydays.", link: SITE });
}

/* ---- send ---- */
const ready = due.filter(r => r.when <= now && r.when > now - r.window * 3600000);
let sent = 0, skipped = 0;
for (const r of ready){
  if (r.key){
    const ref = db.collection("notified").doc(r.key.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 400));
    if ((await ref.get()).exists){ skipped++; continue; }
    const targets = devices.filter(d => r.who === "split" || !d.who || d.who === "split" || d.who === r.who);
    if (!DRY && targets.length) await send(targets, r);
    if (!DRY) await ref.set({ at: now, title: r.title });
  } else {
    if (!DRY) await send([r.device], r);
    if (!DRY) await db.collection("devices").doc(r.device.id).set({ testSent: now }, { merge: true });
  }
  sent++;
}

async function send(targets, r){
  const msg = { tokens: targets.map(d => d.token), webpush: { notification: { title: r.title, body: r.body, icon: SITE + "icons/icon-192.png", badge: SITE + "icons/icon-192.png" }, fcmOptions: { link: r.link } } };
  const res = await getMessaging().sendEachForMulticast(msg);
  res.responses.forEach((x, idx) => {
    if (x.success) return;
    const code = x.error && x.error.code;
    console.log("send failed:", code);
    if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") db.collection("devices").doc(targets[idx].id).delete().catch(() => {});
  });
}

/* ---- tidy: forget sent markers older than 90 days, once a day ---- */
if (!DRY && new Date(now).getHours() === 3 && new Date(now).getMinutes() < 15){
  const old = await db.collection("notified").where("at", "<", now - 90 * 86400000).limit(400).get();
  const b = db.batch(); old.docs.forEach(d => b.delete(d.ref)); if (!old.empty) await b.commit();
}
console.log("devices " + devices.length + " · checked " + due.length + " · due now " + ready.length + " · sent " + sent + " · already sent " + skipped + (DRY ? " (dry run)" : ""));
process.exit(0);
