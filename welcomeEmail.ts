/**
 * The welcome email a person gets after signing up on nowhrms.com.
 *
 * Built from the designed template (table layout, inline styles, 600px wide).
 * The plan and team size they picked change the plan block, the "what happens
 * next" steps and the button, so an Enterprise sign-up and a Custom enquiry do
 * not read the same. Everything the visitor typed is escaped before it goes
 * into the HTML, and the subject never carries their input.
 *
 * Pure: no network and no database, so the wording is pinned down by tests.
 */

export type WelcomeLead = { name: string; company: string; email: string; teamSize: string; plan: string };

export type WelcomeOptions = {
  /** Where the logo images live, without a trailing slash. */
  assetBase: string;
  /** Where the main button goes. A booking page, or a mailto: when there is none. */
  ctaUrl: string;
};

type PlanCopy = {
  label: string;
  price: string;
  includes: string;
  intro: string;
  cta: string;
  steps: [string, string][];
};

const PLANS: Record<"sme" | "enterprise" | "custom" | "other", PlanCopy> = {
  sme: {
    label: "SME",
    price: "$100 a month",
    includes: "10 to 20 staff, 3 admins, time, leave, work, pay and team chat, and a Wingman for every employee.",
    intro: "just swapped five tabs for one workspace: HR, projects, attendance and a personal AI Wingman for every person on the team.",
    cta: "Book my setup call",
    steps: [
      ["We get in touch", "Someone from our team reaches out within one working day to set up your workspace with you."],
      ["Set up the basics", "Your logo, office hours and leave policy. Takes about ten minutes."],
      ["Invite your team and clock in", "Everyone gets their own login and their own Wingman. Attendance, tasks and project health track from the first tap."],
    ],
  },
  enterprise: {
    label: "Enterprise",
    price: "$189 a month",
    includes: "Up to 50 staff, everything in SME, and a Wingman for every employee.",
    intro: "just swapped five tabs for one workspace built for a bigger crew: HR, projects, attendance and a personal AI Wingman for every person on the team.",
    cta: "Book my setup call",
    steps: [
      ["We get in touch", "Someone from our team reaches out within one working day to plan your rollout with you."],
      ["Set up departments and admins", "Your logo, office hours, leave policy, departments and who approves what."],
      ["Bring the whole team in", "Upload your staff list. Everyone gets their own login and their own Wingman from day one."],
    ],
  },
  custom: {
    label: "Custom",
    price: "Priced with sales",
    includes: "A team size that fits you, built around how you work.",
    intro: "is after something bigger or more specific, so we'll shape the plan with you before anything else.",
    cta: "Book a call with sales",
    steps: [
      ["Sales gets in touch", "Within one working day, to hear how your team works and what you need from Now."],
      ["We shape your plan", "Team size, modules, admins and pricing, put together around you."],
      ["We set you up", "Your workspace goes live with your people in it, each with their own Wingman."],
    ],
  },
  other: {
    label: "Now",
    price: "",
    includes: "HR, projects, attendance and a Wingman for every employee.",
    intro: "just swapped five tabs for one workspace: HR, projects, attendance and a personal AI Wingman for every person on the team.",
    cta: "Book my setup call",
    steps: [
      ["We get in touch", "Someone from our team reaches out within one working day to set up your workspace with you."],
      ["Set up the basics", "Your logo, office hours and leave policy. Takes about ten minutes."],
      ["Invite your team and clock in", "Everyone gets their own login and their own Wingman."],
    ],
  },
};

function planKey(plan: string): keyof typeof PLANS {
  const value = plan.trim().toLowerCase();
  if (value === "sme") return "sme";
  if (value === "enterprise") return "enterprise";
  if (value === "custom") return "custom";
  return "other";
}

/** How many people the size choice can mean at most; Infinity for "More than 50". */
function sizeCeiling(teamSize: string): number | null {
  const value = teamSize.toLowerCase();
  if (/more than|\+/.test(value)) return Infinity;
  const numbers = value.match(/\d+/g);
  return numbers ? Number(numbers[numbers.length - 1]) : null;
}

/**
 * A line for when the plan and the team size do not fit together, e.g. SME
 * picked for 40 people. Null when they fit or the size is unknown.
 */
export function sizeNote(plan: string, teamSize: string): string | null {
  const key = planKey(plan);
  const ceiling = sizeCeiling(teamSize);
  if (ceiling === null) return null;
  if (key === "sme" && ceiling > 20) {
    return ceiling > 50
      ? "SME covers up to 20 people. For a team your size, Custom fits better, and we'll talk it through on the call."
      : "SME covers up to 20 people. For a team your size, Enterprise fits better, and we'll talk it through on the call.";
  }
  if (key === "enterprise" && ceiling > 50) {
    return "Enterprise covers up to 50 people. For a team your size, Custom fits better, and we'll talk it through on the call.";
  }
  return null;
}

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const oneLine = (value: string) => value.replace(/[\r\n]+/g, " ").trim();

/** "Sara" from "Sara Khan"; the whole name when there is only one word. */
export function firstNameOf(name: string) {
  return oneLine(name).split(/\s+/)[0] || "there";
}

/** Only web and mail links go into the button, never javascript: or the like. */
function safeUrl(url: string) {
  return /^(https?:|mailto:)/i.test(url) ? url : "https://nowhrms.com";
}

const MONO = "'JetBrains Mono','Courier New',monospace";
const DISPLAY = "'Bricolage Grotesque',Arial,Helvetica,sans-serif";
const BODY = "'Instrument Sans',Arial,Helvetica,sans-serif";

function stepHtml(number: number, title: string, detail: string) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="background:#ffffff; border-radius:18px;">
      <tr>
        <td width="64" valign="top" style="padding:22px 0 22px 22px; font-family:${MONO}; font-size:15px; font-weight:700; color:#ff4b1f;">${String(number).padStart(2, "0")}</td>
        <td valign="top" style="padding:22px 22px 22px 0; font-family:${BODY};">
          <div style="font-size:17px; line-height:24px; font-weight:700; color:#10140f;">${escapeHtml(title)}</div>
          <div style="padding-top:4px; font-size:15px; line-height:23px; color:#5b6258;">${escapeHtml(detail)}</div>
        </td>
      </tr>
    </table>`;
}

export function buildWelcomeEmail(lead: WelcomeLead, options: WelcomeOptions) {
  const copy = PLANS[planKey(lead.plan)];
  const first = firstNameOf(lead.name);
  const company = oneLine(lead.company) || "Your team";
  const teamSize = oneLine(lead.teamSize);
  const note = sizeNote(lead.plan, lead.teamSize);
  const cta = safeUrl(options.ctaUrl);
  const asset = options.assetBase.replace(/\/+$/, "");
  const planTitle = copy.price ? `${copy.label} · ${copy.price}` : copy.label;
  const isCustom = planKey(lead.plan) === "custom";

  const subject = isCustom ? "Thanks for reaching out. Let's build your plan." : "You're in. The time is Now.";
  const preheader = isCustom
    ? "Sales will be in touch within one working day to shape your plan."
    : "We'll be in touch within one working day to set up your workspace.";

  const e = escapeHtml;
  const steps = copy.steps
    .map(([title, detail], index) => stepHtml(index + 1, title, detail))
    .join(`\n    <div style="height:12px; line-height:12px; font-size:0;">&nbsp;</div>\n    `);

  const html = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>${e(subject)}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,700;12..96,800&family=Instrument+Sans:wght@400;600;700&family=JetBrains+Mono:wght@500;700&display=swap" rel="stylesheet">
<style>
  body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
  table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; border-collapse: collapse; }
  img { -ms-interpolation-mode: bicubic; border: 0; outline: none; text-decoration: none; display: block; }
  body { margin: 0 !important; padding: 0 !important; width: 100% !important; background: #f3f4ea; }
  a { color: #ff4b1f; }
  @media (max-width: 620px) {
    .wrap { width: 100% !important; }
    .px { padding-left: 24px !important; padding-right: 24px !important; }
    .h1 { font-size: 44px !important; line-height: 44px !important; }
    .h2 { font-size: 28px !important; line-height: 30px !important; }
    .stack { display: block !important; width: 100% !important; }
    .stack-gap { padding-top: 12px !important; padding-left: 0 !important; }
    .btn a { display: block !important; }
  }
</style>
</head>
<body style="margin:0; padding:0; background:#f3f4ea;">

<div style="display:none; max-height:0; overflow:hidden; mso-hide:all; font-size:1px; line-height:1px; color:#f3f4ea;">
  ${e(preheader)}&#8204;&nbsp;&#8204;&nbsp;&#8204;&nbsp;&#8204;&nbsp;&#8204;&nbsp;&#8204;&nbsp;&#8204;&nbsp;&#8204;&nbsp;
</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f3f4ea" style="background:#f3f4ea;">
<tr><td align="center" style="padding:32px 12px;">

<table role="presentation" class="wrap" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px; max-width:600px;">

  <tr><td bgcolor="#0b0e0a" style="background:#0b0e0a; border-radius:24px 24px 0 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td class="px" style="padding:32px 40px 0 40px;" align="left" valign="middle">
          <a href="https://nowhrms.com" target="_blank"><img src="${e(asset)}/now-logo-white.png" width="96" height="22" alt="Now" style="width:96px; height:auto;"></a>
        </td>
        <td class="px" style="padding:32px 40px 0 0; font-family:${MONO}; font-size:12px; font-weight:700; letter-spacing:1px; color:#a3aa9c; text-transform:uppercase;" align="right" valign="middle">
          [ Welcome ]
        </td>
      </tr>
      <tr>
        <td colspan="2" class="px" style="padding:48px 40px 0 40px;">
          <h1 class="h1" style="margin:0; font-family:${DISPLAY}; font-size:60px; line-height:58px; font-weight:800; letter-spacing:-2px; text-transform:uppercase; color:#f3f4ea;">
            ${isCustom ? "Let's talk.<br><span style=\"color:#ff4b1f;\">The time is Now.</span>" : "You're in.<br><span style=\"color:#ff4b1f;\">The time is Now.</span>"}
          </h1>
        </td>
      </tr>
      <tr>
        <td colspan="2" class="px" style="padding:24px 40px 0 40px; font-family:${BODY}; font-size:17px; line-height:27px; color:#c9cfc4;">
          Hey ${e(first)}, welcome aboard. ${e(company)} ${e(copy.intro)} No more chasing. Just doing.
        </td>
      </tr>
      <tr>
        <td colspan="2" class="px btn" style="padding:32px 40px 44px 40px;" align="left">
          <!--[if mso]>
          <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${e(cta)}" style="height:56px;v-text-anchor:middle;width:260px;" arcsize="25%" stroke="f" fillcolor="#ff4b1f">
            <w:anchorlock/><center style="color:#10140f;font-family:Arial,sans-serif;font-size:16px;font-weight:bold;">${e(copy.cta)} &rarr;</center>
          </v:roundrect>
          <![endif]-->
          <!--[if !mso]><!-->
          <a href="${e(cta)}" target="_blank" style="display:inline-block; padding:18px 30px; border-radius:14px; background-color:#ff4b1f; background-image:linear-gradient(135deg,#ff4b1f,#ff9068); font-family:${BODY}; font-size:16px; font-weight:700; color:#10140f; text-decoration:none; text-align:center;">${e(copy.cta)} &rarr;</a>
          <!--<![endif]-->
        </td>
      </tr>
    </table>
  </td></tr>

  <tr><td height="6" bgcolor="#ff4b1f" style="height:6px; line-height:6px; font-size:0; background-color:#ff4b1f; background-image:linear-gradient(90deg,#ff4b1f,#ff9068);">&nbsp;</td></tr>

  <tr><td bgcolor="#ffffff" class="px" style="background:#ffffff; padding:32px 40px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td class="stack" width="50%" valign="top" style="font-family:${MONO}; font-size:12px; font-weight:700; letter-spacing:1px; text-transform:uppercase; color:#5f665a;">
          Your plan
          <div style="padding-top:6px; font-family:${DISPLAY}; font-size:26px; line-height:30px; font-weight:800; letter-spacing:-0.5px; text-transform:none; color:#10140f;">${e(planTitle)}</div>
        </td>
        <td class="stack stack-gap" width="50%" valign="top" style="padding-left:16px; font-family:${MONO}; font-size:12px; font-weight:700; letter-spacing:1px; text-transform:uppercase; color:#5f665a;">
          Team size
          <div style="padding-top:6px; font-family:${DISPLAY}; font-size:26px; line-height:30px; font-weight:800; letter-spacing:-0.5px; text-transform:none; color:#10140f;">${teamSize ? `${e(teamSize)} people` : "To confirm"}</div>
        </td>
      </tr>
      <tr>
        <td colspan="2" style="padding-top:16px; font-family:${BODY}; font-size:15px; line-height:23px; color:#5b6258;">
          ${e(copy.includes)}${note ? `<div style="margin-top:12px; padding:12px 14px; border-radius:12px; background:#ffe9cc; color:#6b3200;">${e(note)}</div>` : ""}
        </td>
      </tr>
    </table>
  </td></tr>

  <tr><td bgcolor="#f3f4ea" class="px" style="background:#f3f4ea; padding:44px 40px 12px 40px;">
    <div style="font-family:${MONO}; font-size:12px; font-weight:700; letter-spacing:1px; text-transform:uppercase; color:#5f665a;">[01] What happens next</div>
    <h2 class="h2" style="margin:12px 0 0 0; font-family:${DISPLAY}; font-size:34px; line-height:36px; font-weight:800; letter-spacing:-1px; text-transform:uppercase; color:#10140f;">Live in a day. Not a quarter.</h2>
  </td></tr>

  <tr><td bgcolor="#f3f4ea" class="px" style="background:#f3f4ea; padding:20px 40px 0 40px;">
    ${steps}
  </td></tr>

  <tr><td bgcolor="#f3f4ea" class="px" style="background:#f3f4ea; padding:32px 40px 44px 40px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#4233e0" style="background:#4233e0; border-radius:22px;">
      <tr>
        <td style="padding:30px 30px 0 30px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td valign="middle"><img src="${e(asset)}/wingman-logo.png" width="44" height="44" alt="Wingman" style="width:44px; height:44px; border-radius:12px;"></td>
              <td valign="middle" style="padding-left:12px; font-family:${MONO}; font-size:12px; font-weight:700; letter-spacing:1px; text-transform:uppercase; color:#d9d6ff;">[02] Meet your Wingman</td>
            </tr>
          </table>
        </td>
      </tr>
      <tr>
        <td style="padding:20px 30px 0 30px;">
          <h2 class="h2" style="margin:0; font-family:${DISPLAY}; font-size:30px; line-height:32px; font-weight:800; letter-spacing:-1px; text-transform:uppercase; color:#ffffff;">Your AI sidekick. Zero admin.</h2>
        </td>
      </tr>
      <tr>
        <td style="padding:20px 30px 0 30px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr><td align="right" style="padding-bottom:10px;">
              <span style="display:inline-block; max-width:80%; padding:12px 16px; border-radius:16px 16px 4px 16px; background:#2a1fb0; font-family:${BODY}; font-size:15px; line-height:22px; color:#ffffff; text-align:left;">Apply a half day for Monday morning.</span>
            </td></tr>
            <tr><td align="left">
              <span style="display:inline-block; max-width:85%; padding:12px 16px; border-radius:16px 16px 16px 4px; background:#ffffff; font-family:${BODY}; font-size:15px; line-height:22px; color:#10140f;">Ready: casual leave, Monday morning, half day. Send it to your manager?</span>
            </td></tr>
          </table>
        </td>
      </tr>
      <tr>
        <td style="padding:20px 30px 30px 30px; font-family:${BODY}; font-size:15px; line-height:23px; color:#d9d6ff;">
          Clock-ins, leave requests, your plate for the day and project health. Wingman handles the busywork so your team can do the real work.
        </td>
      </tr>
    </table>
  </td></tr>

  <tr><td bgcolor="#ffffff" class="px" style="background:#ffffff; padding:32px 40px; font-family:${BODY}; font-size:15px; line-height:24px; color:#5b6258;">
    <span style="font-weight:700; color:#10140f;">Need a hand?</span> Just reply to this email. A real human on our team reads every one.
  </td></tr>

  <tr><td bgcolor="#0b0e0a" class="px" style="background:#0b0e0a; border-radius:0 0 24px 24px; padding:40px 40px 36px 40px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td valign="middle" style="font-family:${DISPLAY}; font-size:32px; line-height:32px; font-weight:800; letter-spacing:-1px; text-transform:uppercase; color:#f3f4ea; padding-right:12px;">The time is</td>
        <td valign="middle"><img src="${e(asset)}/now-logo-white.png" width="112" height="25" alt="Now" style="width:112px; height:auto;"></td>
      </tr>
    </table>
    <div style="height:28px; line-height:28px; font-size:0; border-bottom:1px solid #262c23;">&nbsp;</div>
    <div style="padding-top:20px; font-family:${MONO}; font-size:12px; line-height:20px; color:#8a9186;">
      <a href="https://nowhrms.com" target="_blank" style="color:#ff9068; text-decoration:none;">nowhrms.com</a>
      &nbsp;·&nbsp; You got this because you signed up on nowhrms.com. Didn't sign up? Just ignore this email.
    </div>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>
`;

  const text = [
    `Hey ${first}, welcome aboard.`,
    "",
    `${company} ${copy.intro}`,
    "",
    `Your plan: ${planTitle}`,
    `Team size: ${teamSize ? `${teamSize} people` : "To confirm"}`,
    copy.includes,
    ...(note ? ["", note] : []),
    "",
    "What happens next",
    ...copy.steps.map(([title, detail], index) => `${index + 1}. ${title}: ${detail}`),
    "",
    `${copy.cta}: ${cta}`,
    "",
    "Need a hand? Just reply to this email. A real human on our team reads every one.",
    "",
    "nowhrms.com. You got this because you signed up on nowhrms.com. Didn't sign up? Just ignore this email.",
  ].join("\n");

  return { subject, html, text };
}
