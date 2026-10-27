# GWS campaign builder: Google Ads connection

Run on your own computer. Needs Node.js 20.6 or newer.

## One-time Google setup
1. Google Cloud Console: create a project and enable the **Google Ads API**.
2. OAuth consent screen: choose External, add your own Google email as a test user.
3. Credentials: create an **OAuth client ID** of type *Web application*. Add this authorised redirect URI exactly: `http://localhost:3000/auth/callback`
4. No developer token is needed any more (Google retired them in September 2026). Enabling the API gives *test* access. To use your real ad account, open the Google Ads API Overview page in Google Cloud Console (console.cloud.google.com/google/ads-apis/overview) and apply for **Explorer access**.

## Run
1. Copy `.env.example` to `.env` and fill in the client ID, client secret and a long random SESSION_SECRET.
2. `npm install`
3. `npm start`, then open http://localhost:3000
4. Click **Connect Google Ads**, sign in, and the page shows **Connected** with the account name and ID.
5. Fill in Steps 1-4, choose **Create new campaign** in Step 5, review, and click **Create Campaign in Google Ads**. It is created **paused**, with one ad group per selected product, so nothing spends until you enable it in Google Ads yourself.

## Optional: cap the daily budget the app will accept
Set `MAX_DAILY_BUDGET=100` (or any number) in `.env` to refuse any campaign above that, on top of your own Approved daily ceiling field.

Tokens stay on the server (in memory, so you reconnect after a restart). Nothing in this version creates or changes campaigns.
