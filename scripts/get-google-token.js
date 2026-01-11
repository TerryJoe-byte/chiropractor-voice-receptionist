import "dotenv/config";
import http from "http";
import open from "open";
import { google } from "googleapis";

console.log("✅ Script started");
console.log("✅ Node version:", process.version);

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI =
  process.env.GOOGLE_REDIRECT_URI || "http://localhost:3000/oauth2callback";

const SCOPES = ["https://www.googleapis.com/auth/calendar.events"];

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("❌ Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in .env");
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI
);

const server = http.createServer(async (req, res) => {
  try {
    if (!req.url?.startsWith("/oauth2callback")) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(
        "Token helper running. Copy the AUTH URL from the terminal and paste it into your browser.\n"
      );
      return;
    }

    const url = new URL(req.url, "http://localhost:3000");
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");

    if (error) {
      console.error("❌ OAuth error:", error);
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("OAuth error. Check terminal.\n");
      server.close();
      return;
    }

    if (!code) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Missing code.\n");
      return;
    }

    const { tokens } = await oauth2Client.getToken(code);

    if (!tokens.refresh_token) {
      console.log("\n⚠️ No refresh_token returned.");
      console.log("If you authorized before, revoke app access and run again.");
    } else {
      console.log("\n✅ COPY THIS INTO YOUR .env FILE:\n");
      console.log("GOOGLE_REFRESH_TOKEN=" + tokens.refresh_token + "\n");
    }

    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Authorized. Check terminal for refresh token. You can close this tab.\n");
    server.close();
  } catch (err) {
    console.error("❌ OAuth callback error:", err);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("OAuth failed. Check terminal logs.\n");
    server.close();
  }
});

server.listen(3000, async () => {
  console.log("✅ Server started on http://localhost:3000");
  console.log("✅ Redirect URI expected:", REDIRECT_URI);

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
  });

  console.log("\n��� COPY/PASTE THIS URL INTO YOUR BROWSER:\n");
  console.log(authUrl + "\n");

  try {
    await open(authUrl);
    console.log("��� Browser open attempted (if it didn’t open, paste the URL above).");
  } catch {
    console.log("❌ Could not auto-open browser. Paste the URL above into Chrome/Edge.");
  }
});
