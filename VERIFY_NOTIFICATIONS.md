# 🧪 Full Notification Pipeline Verification

Run these steps **in order** to verify the complete system works end-to-end.

---

## Prerequisites

1. **Create `.env` in project root** (copy from `.env.example` and fill in your 6 secrets):
   ```bash
   copy .env.example .env
   # Edit .env with your actual values from GitHub secrets
   ```

2. **Install test dependencies**:
   ```bash
   cd scripts && npm install
   ```

---

## Step 1: Find a Test User

```bash
cd scripts
node -e "
require('dotenv').config({ path: '../.env' });
const admin = require('./appwrite-admin.cjs');
admin.initializeApp({ projectId: process.env.APPWRITE_PROJECT_ID });
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

db.collection('users').where('status', '==', 'active').limit(5).get()
  .then(snap => {
    console.log('Active users:', snap.size);
    snap.docs.forEach((d, i) => {
      const data = d.data();
      console.log((i+1) + '. ' + d.id + ' | ' + (data.email || 'no-email') + ' | ' + (data.fullName || 'no-name') + ' | role: ' + (data.role || 'user'));
    });
  })
  .catch(console.error);
"
```

**Pick a test user UID** (preferably an admin so you can also test admin notifications).

---

## Step 2: Add TEST_USER_ID to .env

Edit `.env` and add:
```
TEST_USER_ID=your-chosen-uid-here
```

---

## Step 3: Run Local Pipeline Test

```bash
cd scripts
node ../test-notification.cjs
```

**Expected output:**
```
🧪 Starting notification pipeline test...

📤 Sending test notification to user: <UID>

📝 createNotification result: { id: 'test_xxx', duplicate: false }

📋 Notification document:
   ID: test_xxx
   pushState: queued
   category: system
   title: 🧪 Test Notification

📱 Active push subscriptions for user: 0 (or >0 if push enabled)
⚙️  Notification preferences: push: true, categories: {}

✅ Test notification queued successfully!
```

---

## Step 4: Enable Push on Test Device

1. Open your deployed app: `https://afnokamainp.web.app`
2. Sign in as the test user
3. Go to **Settings → Notification Settings**
4. Click **"Turn on"** → Allow browser permission
5. Verify in console: `Device notifications turned on.`
6. Check Firestore: `pushSubscriptions` collection has a doc for this user+device

---

## Step 5: Push the Workflow & Trigger Manually

```bash
git add .github/workflows/push-sender.yml
git commit -m "ci: add push sender cron workflow"
git push
```

Then in GitHub:
1. **Actions → Push Sender → Run workflow → Run workflow**
2. Watch the log for:
   ```
   [timestamp] push sender starting { project: '6ac536e6001dd29da193' }
   [timestamp] queued notifications 1
   [timestamp] send:1/1
   [timestamp] finished { queued: 1, sent: 1, skipped: 0, failed: 0, retired: 0, errors: 0 }
   ```

---

## Step 6: Verify Push Delivery

### A. On the test device (browser closed)
1. **Close ALL browser tabs** for the app
2. Wait ≤5 minutes
3. **Push notification should appear** on your device/OS
4. Click it → should open `notifications.html`

### B. In-app notification center
1. Reopen the app
2. Click **bell icon** (top right)
3. **Notification appears** in dropdown
4. Click it → marks read, navigates to link

### C. Admin delivery audit
1. Sign in as admin
2. Go to **Admin → Notifications**
3. **Recent activity** shows your test notification with **green "Sent" badge**

---

## Step 7: Test All Scenarios

| Test | How | Verify |
|------|-----|--------|
| **Broadcast to all** | Admin → Notifications → Audience: "Every active user" | All active users get push + in-app |
| **Single user** | Admin → Notifications → Audience: "A single user" + UID | Only that user gets it |
| **Admin only** | Admin → Notifications → Audience: "Admin team only" | Only admins get it |
| **Priority urgent** | Admin → Priority: "Urgent" | Notification pins on screen (requireInteraction) |
| **Security alert** | Change password in profile | Security notification arrives (cannot disable) |
| **Disable push** | Settings → Toggle off | Prefs updated, subscriptions retained |
| **Re-enable push** | Settings → Toggle on | Instant resume, no re-permission prompt |

---

## Step 8: Check Firestore Collections

Verify these collections have correct data:

| Collection | What to Check |
|------------|---------------|
| `notifications` | `pushState: 'sent'`, `pushSentCount > 0`, `pushAt` timestamp |
| `notificationLog` | One row per device: `status: 'sent'`, `provider: 'webpush'` |
| `pushSubscriptions` | `isActive: true`, `failCount: 0`, `lastUsedAt` recent |
| `notificationPrefs` | `push: true`, categories as configured |

---

## Troubleshooting Quick Reference

| Issue | Fix |
|-------|-----|
| Workflow: `missing required secret` | Add all 6 secrets in GitHub Settings |
| Workflow: `web-push TypeError` | VAPID keys must match in GitHub, `firebase-config.js`, `sw.js` |
| Push sent but not received | Browser permission = "Allowed"? SW registered? Check `sw.js` scope |
| Notification stuck `queued` | Workflow not running? Check Actions tab for recent runs |
| `notificationLog` shows `failed` | Check `error` field: `http_410` = dead subscription (auto-retired) |

---

## ✅ Success Criteria

All of these must pass:
- [ ] Workflow runs successfully in GitHub Actions
- [ ] `finished { sent: >0, failed: 0 }` in logs
- [ ] Push notification appears on **closed browser** device
- [ ] In-app bell shows notification
- [ ] Admin audit shows green "Sent" badge
- [ ] `notificationLog` has `status: 'sent'` rows
- [ ] Security alerts cannot be disabled
- [ ] Enable/disable toggle persists across sessions

---

Once all pass → **your notification system is butter smooth.** 🎉