// Types for guestbook 📝 worker.js — vendor this file next to it in a TypeScript project.
export type GuestbookNote = {
  source?: string; title: string; body?: string; url?: string;
  priority?: string; tags?: string; actions?: string[];
};
export type GuestbookResult = { channel: string; status?: number; skipped?: string; error?: string; sid?: string };
export type GuestbookOptions = {
  /** Host auth: replaces the PIN gate (and the /login, /admin/login, /admin/logout routes). */
  isAdmin?: (request: Request, env: any) => boolean | Promise<boolean>;
  /** Where a signed-out visitor to /admin is sent when isAdmin is set (default "/login"). */
  loginUrl?: string;
  /** Dashboard "Log out" target when isAdmin is set (omit = no button). */
  logoutUrl?: string;
  /** Derives the Sheets export key when there is no ADMIN_PIN. */
  secret?: string;
  /** Display name for notifications and the dashboard title (default: hostname). */
  site?: string;
  copy?: {
    title?: string; heading?: string; lede?: string; noteLabel?: string; button?: string;
    thanksHeading?: string; thanksBody?: string;
  };
  prefill?: { first?: string; last?: string; email?: string };
  /** Omit for no phone / text opt-in field. */
  sms?: { sender?: string; frequency?: string; termsUrl?: string; privacyUrl?: string };
  /** Wrap /signup and /thanks in the host layout; `body` is trusted HTML. */
  shell?: (page: { kind: "signup" | "thanks"; title: string; body: string }) => string | Response | Promise<string | Response>;
  /** Extra CSS appended to the standalone pages (PIN page, dashboard, unshelled form). */
  css?: string;
  /** Default email recipient (else env.NOTIFY_TO). */
  notifyTo?: string;
  /** The host's mailer, used instead of Resend. */
  sendEmail?: (env: any, note: GuestbookNote, to: string) => Promise<Omit<GuestbookResult, "channel">>;
};
export function handleGuestbook(request: Request, env: any, ctx: { waitUntil(p: Promise<unknown>): void }, opts?: GuestbookOptions): Promise<Response | null>;
export function recordSignup(
  request: Request, env: any, ctx: { waitUntil(p: Promise<unknown>): void },
  signup: { email: string; first?: string; last?: string; note?: string; phone?: string | null; optin?: boolean },
  opts?: GuestbookOptions
): Promise<void>;
export function notify(env: any, note: GuestbookNote, opts?: GuestbookOptions): Promise<GuestbookResult[]>;
export function isAdmin(request: Request, env: any): Promise<boolean>;
export function sendEmail(env: any, note: GuestbookNote, to: string, opts?: GuestbookOptions): Promise<GuestbookResult>;
export function sendSms(env: any, to: string, body: string): Promise<GuestbookResult>;
export const esc: (s: unknown) => string;
export const html: (body: string, status?: number) => Response;
export const redirect: (to: string) => Response;
