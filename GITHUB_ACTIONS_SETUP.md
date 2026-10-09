# GitHub Actions Setup for Push Sender

This document explains how to deploy the push notification sender as a GitHub Actions cron job.

## Required GitHub Secrets

Go to your GitHub repository → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**

Add these 6 secrets (values from your Appwrite project and VAPID keys):

| Secret Name | Value Source |
|-------------|--------------|
| `APPWRITE_API_KEY` | Appwrite Console → Functions → `afnokamai-bridge` → Settings → Variables → `APPWRITE_API_KEY` |
| `APPWRITE_PROJECT_ID` | `6ac536e6001dd29da193` (from `appwrite.config.json`) |
| `APPWRITE_DATABASE_ID` | `6ac53c92002a02a202fe` (from `appwrite.config.json` / Appwrite Console) |
| `VAPID_SUBJECT` | `mailto:support@afnokamainp.web.app` (or your contact email) |
| `VAPID_PUBLIC_KEY` | Your VAPID public key (from `js/firebase-config.js` or generate new) |
| `VAPID_PRIVATE_KEY` | Your VAPID private key (generate with `npx web-push generate-vapid-keys`) |

## Generate VAPID Keys (if needed)

```bash
cd scripts
npm install
npx web-push generate-vapid-keys
```

Copy the output:
- **Public Key** → `VAPID_PUBLIC_KEY` secret
- **Private Key** → `VAPID_PRIVATE_KEY` secret

Also update `js/firebase-config.js` with the new public key:
```js
export const VAPID_PUBLIC_KEY = "YOUR_NEW_PUBLIC_KEY";
```

## Deploy

1. Push the `.github/workflows/push-sender.yml` file to GitHub
2. The workflow runs automatically every 5 minutes via cron
3. Or trigger manually: Actions → Push Sender → Run workflow

## Verify It Works

1. Go to **Actions** tab in GitHub
2. Click **Push Sender** workflow
3. Click **Run workflow** → **Run workflow**
4. Check the logs - you should see:
   ```
   [timestamp] push sender starting { project: '6ac536e6001dd29da193', trigger: 'direct' }
   [timestamp] queued notifications { count: X }
   [timestamp] finished { queued: X, sent: Y, skipped: Z, failed: 0, retired: 0, errors: 0 }
   ```

## Troubleshooting

| Error | Fix |
|-------|-----|
| `missing required secret(s)` | Add all 6 secrets in GitHub Settings |
| `could not load Firebase signing keys` | Check `APPWRITE_API_KEY` is correct |
| `web-push TypeError` | Verify `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` match |
| `notificationLog` row id too long | Already fixed in `scripts/appwrite-admin.cjs` (rowIdOf compaction) |

## Architecture

The workflow runs `scripts/push-sender.cjs` which:
1. Uses `scripts/appwrite-admin.cjs` - Appwrite TablesDB behind Firestore API
2. Claims queued notifications (`pushState: 'queued' → 'sending'`)
3. Sends via web-push to user endpoints
4. Logs delivery to `notificationLog` table
5. Retries failed sends (max 3 attempts)
6. Cleans up dead subscriptions (failCount ≥ 5)
7. Backfills `category`/`searchText` on legacy notifications

The Appwrite Function (`push-fn`) does the same thing as a backup, triggered by document creation.