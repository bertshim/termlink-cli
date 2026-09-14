/**
 * The Google OAuth client the published package signs in with. A desktop ("installed")
 * client's secret is not confidential by Google's own definition; PKCE protects the
 * flow. Fill these in before publishing, or point TERMLINK_GOOGLE_CLIENT_SECRET_FILE at
 * a client_secret_*.json download (see auth/login.ts).
 */
export const DEFAULT_GOOGLE_CLIENT_ID = "";
export const DEFAULT_GOOGLE_CLIENT_SECRET = "";
