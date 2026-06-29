const crypto = require("crypto");

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;
const WEBHOOK_SECRET = process.env.CAL_WEBHOOK_SECRET; // optional — see note at bottom

// Disable Vercel's automatic body parsing. Signature verification needs the
// exact raw bytes Cal.com signed, not a re-serialized copy of the JSON.
module.exports.config = {
  api: { bodyParser: false },
};

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function verifySignature(rawBody, signature, secret) {
  if (!secret) return true; // no secret configured yet — skip verification
  if (!signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false; // mismatched lengths throw — treat as invalid, not a crash
  }
}

// Cal.com's `responses` object shape: { fieldKey: { label, value, isHidden } }
// Safely extracts `.value`, returns null if the field is missing entirely.
function getValue(responses, key) {
  const field = responses?.[key];
  if (!field) return null;
  if (field.value === undefined || field.value === null) return null;
  return field.value;
}

function capitalizeTier(tier) {
  const lower = String(tier).toLowerCase();
  if (lower === "foundation") return "Foundation";
  if (lower === "growth") return "Growth";
  if (lower === "authority") return "Authority";
  return tier; // fall back to whatever was sent, rather than silently dropping it
}

async function createNotionRecord({
  name,
  email,
  phone,
  businessName,
  notes,
  tier,
  totalQuote,
  deposit,
}) {
  const properties = {
    Name: {
      title: [{ text: { content: name } }],
    },
    "Lead Status": {
      select: { name: "Booked" },
    },
  };

  if (email) properties.Email = { email };
  if (phone) properties.Phone = { phone_number: phone };
  if (businessName) {
    properties["Business Name"] = {
      rich_text: [{ text: { content: businessName } }],
    };
  }
  if (notes) {
    properties["Business Notes"] = {
      rich_text: [{ text: { content: notes } }],
    };
  }
  if (tier) properties.Tier = { select: { name: tier } };
  if (totalQuote) properties["Total Quote"] = { number: totalQuote };
  if (deposit) properties["Deposit 40%"] = { number: deposit };

  const response = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      parent: { database_id: NOTION_DATABASE_ID },
      properties,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Notion API error (${response.status}): ${errText}`);
  }

  return response.json();
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  const rawBody = await getRawBody(req);
  const signature = req.headers["x-cal-signature-256"];

  if (!verifySignature(rawBody, signature, WEBHOOK_SECRET)) {
    return res.status(401).send("Invalid signature");
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return res.status(400).send("Invalid JSON");
  }

  const { triggerEvent, payload } = body;

  // Only act on the moment payment actually clears. Everything else
  // (PING test events, BOOKING_CREATED, cancellations, etc.) is
  // acknowledged but ignored.
  if (triggerEvent !== "BOOKING_PAID") {
    return res.status(200).send("Ignored — not a BOOKING_PAID event");
  }

  if (!payload) {
    return res.status(200).send("Ignored — no payload");
  }

  try {
    const responses = payload.responses || {};

    const name = getValue(responses, "name") || "Unknown";
    const email = getValue(responses, "email") || "";
    const phone = getValue(responses, "attendeePhoneNumber") || "";
    const businessName = getValue(responses, "Business-Name") || "";
    const notes = getValue(responses, "notes") || "";
    const tier = capitalizeTier(getValue(responses, "package") || "");
    const totalQuote = Number(getValue(responses, "price")) || 0;
    const deposit = Number(getValue(responses, "deposit")) || 0;

    await createNotionRecord({
      name,
      email,
      phone,
      businessName,
      notes,
      tier,
      totalQuote,
      deposit,
    });

    return res.status(200).send("OK");
  } catch (err) {
    console.error("Notion record creation failed:", err);
    return res.status(500).send("Internal Server Error");
  }
};

// NOTE ON CAL_WEBHOOK_SECRET:
// If you haven't set a signing secret on the Cal.com webhook yet,
// verifySignature() above will skip verification entirely (anyone who
// knows this URL could POST fake data to it). To lock this down: in Cal.com
// go to Settings -> Developer -> Webhooks -> your webhook -> add a Secret,
// then add the same value as CAL_WEBHOOK_SECRET in Vercel's environment
// variables. Once both are set, verification turns on automatically.
