import { Resend } from "resend";

type Locale = "en" | "es";

const BRAND = {
  blue: "#3B82F6",
  black: "#0a0a0a",
  textMuted: "#9ca3af",
};

// 'Geist' is the app's UI font (see f1-telemetry/app/layout.tsx). Apple
// Mail, iOS Mail and new Outlook actually fetch @font-face webfonts and
// will render this; Gmail and classic Outlook strip @font-face entirely
// and always fall back to the next name in the stack — Helvetica/Arial is
// the closest system match to Geist's proportions, so the email still
// looks consistent for the (majority) of recipients who land on that
// fallback.
const FONT_STACK = "'Geist', Helvetica, Arial, sans-serif";
const FONT_IMPORT = `@import url('https://fonts.googleapis.com/css2?family=Geist:wght@400;500;700&display=swap');`;

// Shared chrome (header wordmark + footer) so every transactional email looks
// consistent. Email clients need inline styles and table layout — no
// external stylesheets, and Outlook ignores most modern CSS.
function renderEmailLayout(locale: Locale, bodyHtml: string): string {
  const footerCopy =
    locale === "es"
      ? {
          automated:
            "Este es un correo automático, por favor no respondas a este mensaje.",
          thanks: "Gracias por usar F1 Telemetry.",
        }
      : {
          automated:
            "This is an automated message — please don't reply to this email.",
          thanks: "Thank you for using F1 Telemetry!",
        };

  return `
    <style>${FONT_IMPORT}</style>
    <div style="background-color:#f4f4f5;padding:32px 16px;font-family:${FONT_STACK};">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto;border-collapse:collapse;">
        <tr>
          <td style="background-color:${BRAND.black};border-radius:8px 8px 0 0;padding:14px 32px;text-align:center;">
            <span style="font-family:${FONT_STACK};font-size:18px;font-weight:600;letter-spacing:1px;color:#ffffff;">F1 TELEMETRY</span>
          </td>
        </tr>
        <tr>
          <td style="background-color:#ffffff;padding:32px;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;font-family:${FONT_STACK};">
            ${bodyHtml}
          </td>
        </tr>
        <tr>
          <td style="background-color:#fafafa;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;padding:20px 32px;text-align:center;font-family:${FONT_STACK};">
            <p style="margin:0 0 6px;font-size:12px;line-height:1.5;color:${BRAND.textMuted};">${footerCopy.automated}</p>
            <p style="margin:0;font-size:12px;line-height:1.5;color:${BRAND.textMuted};">${footerCopy.thanks}</p>
          </td>
        </tr>
      </table>
    </div>
  `;
}

const PASSWORD_RESET_COPY: Record<
  Locale,
  { subject: string; html: (resetUrl: string) => string }
> = {
  en: {
    subject: "Reset your F1 Telemetry password",
    html: (resetUrl) =>
      renderEmailLayout(
        "en",
        `
          <h1 style="margin:0 0 16px;font-size:18px;color:${BRAND.black};">Reset your password</h1>
          <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#374151;">
            We received a request to reset the password for your F1 Telemetry account.
            Click the button below to choose a new one. This link expires in 30 minutes.
          </p>
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
            <tr>
              <td style="border-radius:6px;background-color:${BRAND.blue};">
                <a href="${resetUrl}" style="display:inline-block;padding:12px 28px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;">Choose a new password</a>
              </td>
            </tr>
          </table>
          <p style="margin:0 0 8px;font-size:12px;line-height:1.6;color:${BRAND.textMuted};">
            Button not working? Copy and paste this link into your browser:
          </p>
          <p style="margin:0 0 20px;font-size:12px;line-height:1.6;word-break:break-all;">
            <a href="${resetUrl}" style="color:${BRAND.blue};">${resetUrl}</a>
          </p>
          <p style="margin:0;font-size:13px;line-height:1.6;color:#374151;">
            If you didn't request this, you can safely ignore this email — your password won't be changed.
          </p>
        `,
      ),
  },
  es: {
    subject: "Restablecé tu contraseña de F1 Telemetry",
    html: (resetUrl) =>
      renderEmailLayout(
        "es",
        `
          <h1 style="margin:0 0 16px;font-size:18px;color:${BRAND.black};">Restablecé tu contraseña</h1>
          <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#374151;">
            Recibimos una solicitud para restablecer la contraseña de tu cuenta de F1 Telemetry.
            Hacé clic en el botón de abajo para elegir una nueva. Este enlace expira en 30 minutos.
          </p>
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
            <tr>
              <td style="border-radius:6px;background-color:${BRAND.blue};">
                <a href="${resetUrl}" style="display:inline-block;padding:12px 28px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;">Elegir nueva contraseña</a>
              </td>
            </tr>
          </table>
          <p style="margin:0 0 8px;font-size:12px;line-height:1.6;color:${BRAND.textMuted};">
            ¿El botón no funciona? Copiá y pegá este enlace en tu navegador:
          </p>
          <p style="margin:0 0 20px;font-size:12px;line-height:1.6;word-break:break-all;">
            <a href="${resetUrl}" style="color:${BRAND.blue};">${resetUrl}</a>
          </p>
          <p style="margin:0;font-size:13px;line-height:1.6;color:#374151;">
            Si no solicitaste esto, podés ignorar este correo — tu contraseña no será modificada.
          </p>
        `,
      ),
  },
};

export class EmailService {
  private client: Resend | null;
  private readonly from = process.env.EMAIL_FROM || "no-reply@f1telemetry.com";

  constructor() {
    const apiKey = process.env.RESEND_API_KEY;
    this.client = apiKey ? new Resend(apiKey) : null;
    if (!this.client) {
      console.warn(
        "RESEND_API_KEY not set — password reset emails will be skipped.",
      );
    }
  }

  async sendPasswordResetEmail(
    to: string,
    resetUrl: string,
    locale: Locale = "en",
  ): Promise<void> {
    if (!this.client) return;

    const copy = PASSWORD_RESET_COPY[locale] ?? PASSWORD_RESET_COPY.en;

    await this.client.emails.send({
      from: `F1 Telemetry <${this.from}>`,
      to,
      subject: copy.subject,
      html: copy.html(resetUrl),
    });
  }
}
