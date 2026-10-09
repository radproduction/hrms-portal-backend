import { describe, expect, it } from "vitest";
import { buildWelcomeEmail, firstNameOf, sizeNote } from "./welcomeEmail";
import { sendWelcomeEmail } from "./leads";

const options = { assetBase: "https://nowhrms.com/email/images/", ctaUrl: "https://cal.example.com/now" };
const lead = { name: "Sara Khan", company: "Acme", email: "sara@acme.com", teamSize: "10 to 20", plan: "SME" };

describe("welcome email wording", () => {
  it("greets by first name and shows the plan and team size they picked", () => {
    const mail = buildWelcomeEmail(lead, options);
    expect(mail.subject).toBe("You're in. The time is Now.");
    expect(mail.html).toContain("Hey Sara, welcome aboard. Acme just swapped five tabs");
    expect(mail.html).toContain("SME · $100 a month");
    expect(mail.html).toContain("10 to 20 people");
    expect(mail.html).toContain("https://nowhrms.com/email/images/now-logo-white.png");
    expect(mail.html).not.toMatch(/\{\{/);
    expect(mail.text).toContain("Your plan: SME · $100 a month");
  });

  it("changes the plan block and the steps for Enterprise and Custom", () => {
    const enterprise = buildWelcomeEmail({ ...lead, plan: "Enterprise", teamSize: "21 to 50" }, options);
    expect(enterprise.html).toContain("Enterprise · $189 a month");
    expect(enterprise.html).toContain("Bring the whole team in");

    const custom = buildWelcomeEmail({ ...lead, plan: "Custom", teamSize: "More than 50" }, options);
    expect(custom.subject).toBe("Thanks for reaching out. Let's build your plan.");
    expect(custom.html).toContain("Priced with sales");
    expect(custom.html).toContain("Sales gets in touch");
    expect(custom.html).toContain("Book a call with sales");
    expect(custom.html).toContain("More than 50 people");
  });

  it("points out a plan that is too small for the team", () => {
    expect(sizeNote("SME", "10 to 20")).toBeNull();
    expect(sizeNote("SME", "21 to 50")).toMatch(/Enterprise fits better/);
    expect(sizeNote("SME", "More than 50")).toMatch(/Custom fits better/);
    expect(sizeNote("Enterprise", "More than 50")).toMatch(/Custom fits better/);
    expect(sizeNote("Enterprise", "21 to 50")).toBeNull();
    expect(sizeNote("Custom", "10 to 20")).toBeNull();
    expect(buildWelcomeEmail({ ...lead, teamSize: "21 to 50" }, options).html).toContain("SME covers up to 20 people");
  });

  it("escapes what the visitor typed and keeps it out of the subject", () => {
    const mail = buildWelcomeEmail(
      { ...lead, name: '<b>Sara</b>\r\nBcc: x@evil.example', company: '"><script>alert(1)</script>' },
      options
    );
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).not.toContain("<b>Sara");
    expect(mail.html).toContain("&lt;script&gt;");
    expect(mail.subject).not.toMatch(/Sara|script/);
  });

  it("never puts a script link in the button", () => {
    const mail = buildWelcomeEmail(lead, { ...options, ctaUrl: "javascript:alert(1)" });
    expect(mail.html).not.toContain("javascript:");
  });

  it("falls back sensibly on an unknown plan and a one-word name", () => {
    expect(firstNameOf("Sara")).toBe("Sara");
    expect(firstNameOf("   ")).toBe("there");
    const mail = buildWelcomeEmail({ ...lead, plan: "", teamSize: "" }, options);
    expect(mail.html).toContain("To confirm");
    expect(mail.html).not.toMatch(/\{\{/);
  });
});

describe("sendWelcomeEmail", () => {
  const env = {
    BREVO_API_KEY: "xkeysib-test",
    LEADS_FROM_EMAIL: "Now <hello@example.com>",
    LEADS_NOTIFY_EMAILS: "team@example.com, other@example.com",
  };

  it("sends to the person who signed up, with replies going to the team", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("{}", { status: 201 });
    }) as unknown as typeof fetch;
    expect(await sendWelcomeEmail(lead, env, fake)).toBe("sent");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.to).toEqual([{ email: "sara@acme.com" }]);
    expect(body.replyTo).toEqual({ email: "team@example.com" });
    expect(body.sender).toEqual({ name: "Now", email: "hello@example.com" });
    // No booking page set: the button opens a reply to the team.
    expect(body.htmlContent).toContain("mailto:team@example.com?subject=Setting%20up%20Now%20for%20Acme");
  });

  it("uses the booking page and reply address when they are set", async () => {
    const calls: RequestInit[] = [];
    const fake = (async (_url: string, init: RequestInit) => { calls.push(init); return new Response("{}", { status: 201 }); }) as unknown as typeof fetch;
    await sendWelcomeEmail(lead, { ...env, WELCOME_CTA_URL: "https://cal.example.com/now", LEADS_REPLY_TO: "sales@example.com" }, fake);
    const body = JSON.parse(String(calls[0].body));
    expect(body.replyTo).toEqual({ email: "sales@example.com" });
    expect(body.htmlContent).toContain('href="https://cal.example.com/now"');
  });

  it("can be switched off, does nothing unconfigured, and never throws", async () => {
    let called = 0;
    const counting = (async () => { called += 1; return new Response("{}", { status: 201 }); }) as unknown as typeof fetch;
    expect(await sendWelcomeEmail(lead, { ...env, WELCOME_EMAIL: "off" }, counting)).toBe("off");
    expect(await sendWelcomeEmail(lead, { ...env, BREVO_API_KEY: "" }, counting)).toBe("not_configured");
    expect(called).toBe(0);
    const broken = (async () => { throw new Error("down"); }) as unknown as typeof fetch;
    expect(await sendWelcomeEmail(lead, env, broken)).toBe("failed");
  });
});
