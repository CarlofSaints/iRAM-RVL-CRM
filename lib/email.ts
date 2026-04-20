import { Resend } from 'resend';

let _resend: Resend | null = null;
function getResend() {
  if (!_resend) _resend = new Resend(process.env.RESEND_API_KEY!);
  return _resend;
}

const FROM = 'iRam RVL CRM <report_sender@outerjoin.co.za>';
const PRIMARY = '#7CC042';

function getAppUrl() {
  return process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000';
}

function emailShell(bodyContent: string) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;border:1px solid #e5e5e5;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:${PRIMARY};">
        <tr>
          <td style="padding:20px 28px;">
            <div style="color:#fff;font-size:20px;font-weight:bold;letter-spacing:1px;margin:0;">iRAM RVL CRM</div>
            <div style="color:#fff;margin:3px 0 0;opacity:0.85;font-size:12px;">Reverse Logistics Value &bull; Powered by OuterJoin</div>
          </td>
        </tr>
      </table>
      <div style="padding:32px 28px;background:#fff;">
        ${bodyContent}
      </div>
      <div style="padding:14px 28px;text-align:center;font-size:11px;color:#999;background:#f9f9f9;border-top:1px solid #eee;">
        iRam RVL CRM &bull; Powered by OuterJoin
      </div>
    </div>
  `;
}

export async function sendWelcomeEmail(to: string, name: string, password: string) {
  const appUrl = getAppUrl();
  const body = `
    <p style="margin:0 0 14px;">Hi <strong>${name}</strong>,</p>
    <p style="margin:0 0 8px;">Your account has been created on <strong>iRam RVL CRM</strong>.</p>
    <p style="margin:0 0 20px;color:#555;font-size:14px;">This is the portal used to manage Reverse Logistics Value operations.</p>
    <table style="background:#f9f9f9;border:1px solid #eee;border-radius:6px;padding:14px 16px;width:100%;margin-bottom:20px;">
      <tr><td style="padding:4px 12px 4px 0;color:#666;font-size:13px;">Login URL</td><td style="font-size:13px;"><a href="${appUrl}/login" style="color:${PRIMARY};">${appUrl}/login</a></td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#666;font-size:13px;">Email</td><td style="font-size:13px;">${to}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#666;font-size:13px;">Password</td><td style="font-size:13px;font-family:monospace;">${password}</td></tr>
    </table>
    <p style="margin:0 0 20px;color:#666;font-size:13px;">Please change your password after your first login.</p>
    <a href="${appUrl}/login" style="background:${PRIMARY};color:#fff;text-decoration:none;padding:12px 24px;border-radius:4px;font-weight:bold;font-size:14px;display:inline-block;">Login Now</a>
  `;

  return getResend().emails.send({
    from: FROM,
    to,
    subject: 'Welcome to iRam RVL CRM',
    html: emailShell(body),
  });
}

export async function sendUpgradeRequestEmail(
  toAdmins: string[],
  requester: { name: string; email: string; role: string }
) {
  if (toAdmins.length === 0) return;
  const appUrl = getAppUrl();
  const body = `
    <p style="margin:0 0 14px;">A user has requested to upgrade their subscription.</p>
    <table style="background:#f9f9f9;border:1px solid #eee;border-radius:6px;padding:14px 16px;width:100%;margin-bottom:20px;">
      <tr><td style="padding:4px 12px 4px 0;color:#666;font-size:13px;">Name</td><td style="font-size:13px;"><strong>${requester.name}</strong></td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#666;font-size:13px;">Email</td><td style="font-size:13px;">${requester.email}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#666;font-size:13px;">Role</td><td style="font-size:13px;">${requester.role}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#666;font-size:13px;">Plan requested</td><td style="font-size:13px;">Pro</td></tr>
    </table>
    <p style="margin:0 0 20px;color:#555;font-size:13px;">Open the user record in admin to complete the upgrade.</p>
    <a href="${appUrl}/admin/users" style="background:${PRIMARY};color:#fff;text-decoration:none;padding:12px 24px;border-radius:4px;font-weight:bold;font-size:14px;display:inline-block;">Open User Management</a>
  `;

  return getResend().emails.send({
    from: FROM,
    to: toAdmins,
    subject: `iRam RVL CRM — Pro upgrade requested by ${requester.name}`,
    html: emailShell(body),
  });
}

export async function sendUpgradeConfirmedEmail(to: string, name: string) {
  const appUrl = getAppUrl();
  const body = `
    <p style="margin:0 0 14px;">Hi <strong>${name}</strong>,</p>
    <p style="margin:0 0 14px;">Your subscription has been upgraded to <strong>Pro</strong>. Pro features are now available on your account.</p>
    <p style="margin:0 0 20px;color:#555;font-size:14px;">If you have any questions, reply to this email or get in touch with your iRam account manager.</p>
    <a href="${appUrl}/account" style="background:${PRIMARY};color:#fff;text-decoration:none;padding:12px 24px;border-radius:4px;font-weight:bold;font-size:14px;display:inline-block;">Open Account</a>
  `;

  return getResend().emails.send({
    from: FROM,
    to,
    subject: 'iRam RVL CRM — Welcome to Pro',
    html: emailShell(body),
  });
}

export async function sendPickSlipEmail(opts: {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  bodyHtml: string;
  attachments: Array<{ filename: string; content: Buffer }>;
}) {
  const attachments = opts.attachments.map(a => ({
    filename: a.filename,
    content: a.content.toString('base64'),
  }));

  return getResend().emails.send({
    from: FROM,
    to: opts.to,
    cc: opts.cc?.length ? opts.cc : undefined,
    bcc: opts.bcc?.length ? opts.bcc : undefined,
    subject: opts.subject,
    html: emailShell(opts.bodyHtml),
    attachments,
  });
}

export async function sendPasswordResetEmail(to: string, name: string, password: string) {
  const appUrl = getAppUrl();
  const body = `
    <p style="margin:0 0 14px;">Hi <strong>${name}</strong>,</p>
    <p style="margin:0 0 20px;">Your password has been reset. Use the credentials below to log in.</p>
    <table style="background:#f9f9f9;border:1px solid #eee;border-radius:6px;padding:14px 16px;width:100%;margin-bottom:20px;">
      <tr><td style="padding:4px 12px 4px 0;color:#666;font-size:13px;">Email</td><td style="font-size:13px;">${to}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#666;font-size:13px;">New Password</td><td style="font-size:13px;font-family:monospace;">${password}</td></tr>
    </table>
    <a href="${appUrl}/login" style="background:${PRIMARY};color:#fff;text-decoration:none;padding:12px 24px;border-radius:4px;font-weight:bold;font-size:14px;display:inline-block;">Login Now</a>
  `;

  return getResend().emails.send({
    from: FROM,
    to,
    subject: 'iRam RVL CRM — Password Reset',
    html: emailShell(body),
  });
}
