/**
 * Test script to validate the full notification pipeline.
 * Run with: node test-notification.js
 * Requires: .env file with the 6 required secrets
 */

require('dotenv').config();
const admin = require('./scripts/appwrite-admin.cjs');
const { createNotification, notifyUser } = require('./js/notify.js');

const REQUIRED_ENV = [
  'APPWRITE_API_KEY',
  'APPWRITE_PROJECT_ID',
  'APPWRITE_DATABASE_ID',
  'VAPID_SUBJECT',
  'VAPID_PUBLIC_KEY',
  'VAPID_PRIVATE_KEY'
];

const missingEnv = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missingEnv.length) {
  console.error('❌ Missing required environment variables:', missingEnv.join(', '));
  console.error('Create a .env file with the 6 secrets from GitHub.');
  process.exit(1);
}

// Initialize admin SDK
admin.initializeApp({ projectId: process.env.APPWRITE_PROJECT_ID });
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

async function runTest() {
  console.log('🧪 Starting notification pipeline test...\n');

  // 1. Get current user (you need to be signed in)
  // For this test, we'll use a known test user ID or create a test notification directly
  const testUserId = process.env.TEST_USER_ID;
  
  if (!testUserId) {
    console.log('ℹ️  No TEST_USER_ID in .env — listing active users to pick one:');
    const users = await db.collection('users')
      .where('status', '==', 'active')
      .limit(5)
      .get();
    
    if (users.empty) {
      console.error('❌ No active users found. Create a test account first.');
      process.exit(1);
    }
    
    users.docs.forEach((doc, i) => {
      const d = doc.data();
      console.log(`  ${i + 1}. ${doc.id} — ${d.email || 'no email'} (${d.fullName || 'no name'})`);
    });
    
    console.log('\nAdd TEST_USER_ID=<uid> to .env and re-run.');
    process.exit(0);
  }

  console.log(`📤 Sending test notification to user: ${testUserId}\n`);

  // 2. Create a test notification (this queues it with pushState: 'queued')
  const result = await createNotification({
    userId: testUserId,
    type: 'test_manual',
    category: 'system',
    title: '🧪 Test Notification',
    body: `Pipeline test at ${new Date().toLocaleString()}. If you see this, the write path works!`,
    link: 'notifications.html',
    priority: 'high',
    eventId: `test_${Date.now()}`
  });

  console.log('📝 createNotification result:', result);

  if (!result.id) {
    console.error('❌ Failed to create notification');
    process.exit(1);
  }

  // 3. Verify the notification document exists with pushState: 'queued'
  const notifDoc = await db.collection('notifications').doc(result.id).get();
  if (!notifDoc.exists) {
    console.error('❌ Notification document not found in Firestore');
    process.exit(1);
  }

  const notifData = notifDoc.data();
  console.log('\n📋 Notification document:');
  console.log(`   ID: ${notifDoc.id}`);
  console.log(`   pushState: ${notifData.pushState}`);
  console.log(`   category: ${notifData.category}`);
  console.log(`   title: ${notifData.title}`);

  if (notifData.pushState !== 'queued') {
    console.warn('⚠️  Expected pushState=queued, got:', notifData.pushState);
  }

  // 4. Check if user has push subscriptions
  const subs = await db.collection('pushSubscriptions')
    .where('userId', '==', testUserId)
    .where('isActive', '==', true)
    .get();

  console.log(`\n📱 Active push subscriptions for user: ${subs.size}`);
  if (subs.empty) {
    console.log('   ℹ️  No active subscriptions — push will be skipped (in-app only)');
    console.log('   → Enable push in Settings → Notification Settings to test delivery');
  } else {
    subs.docs.forEach((doc) => {
      const d = doc.data();
      console.log(`   - ${doc.id}: ${d.deviceName} (failCount: ${d.failCount || 0})`);
    });
  }

  // 5. Check notification preferences
  const prefsDoc = await db.collection('notificationPrefs').doc(testUserId).get();
  if (prefsDoc.exists) {
    const prefs = prefsDoc.data();
    console.log('\n⚙️  Notification preferences:');
    console.log(`   push: ${prefs.push}`);
    console.log(`   categories:`, prefs.categories || '{} (all on)');
  } else {
    console.log('\n⚙️  No preferences document — defaults apply (push: on, all categories on)');
  }

  console.log('\n✅ Test notification queued successfully!');
  console.log('\n📋 Next steps to verify FULL pipeline:');
  console.log('   1. Push the workflow: git add .github/workflows/push-sender.yml && git commit -m "ci: add push sender" && git push');
  console.log('   2. In GitHub: Actions → Push Sender → Run workflow');
  console.log('   3. Watch logs for: "finished { sent: 1, ... }"');
  console.log('   4. Check notificationLog collection for delivery record');
  console.log('   5. On device: notification should appear (if push enabled)');
  console.log('   6. In app: bell dropdown should show the notification');
}

runTest().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});