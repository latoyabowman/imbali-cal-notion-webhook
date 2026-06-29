const crypto = require('crypto');
const { Client } = require('@notionhq/client');

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const DATABASE_ID = process.env.NOTION_DATABASE_ID;
const WEBHOOK_SECRET = process.env.CAL_WEBHOOK_SECRET;

// Disable Vercel's automatic body parsing — signature verification needs
// the exact raw bytes Cal.com signed, not a re-serialized copy.
module.exports.config = {
  api: { bodyParser: false },
};

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function verifySignature(rawBody, signature, secret) {
  if (!signature || !secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false; // mismatched lengths throw — treat as invalid, not a crash
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  const rawBody = await getRawBody(req);
  const signature = req.headers['x-cal-signature-256'];

  if (!verifySignature(rawBody, signature, WEBHOOK_SECRET)) {
    return res.status(401).send('Invalid signature');
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return res.status(400).send('Invalid JSON');
  }

  const { triggerEvent, payload } = body;

  // Only act on the moment payment actually clears.
  if (triggerEvent !== 'BOOKING_PAID') {
    return res.status(200).send('Ignored — not a BOOKING_PAID event');
  }

  const attendee = payload?.attendees?.[0] || {};
  const email = attendee.email;
  const name = attendee.name;

  if (!email) {
    return res.status(400).send('No attendee email in payload');
  }

  try {
    // Match by email so this lands on the same Notion row as any
    // existing Tally submission, instead of creating a duplicate.
    const existing = await notion.databases.query({
      database_id: DATABASE_ID,
      filter: { property: 'Email', email: { equals: email } },
    });

    const bookingProps = {
      'Lead Status': { select: { name: 'Booked' } },
    };

    if (existing.results.length > 0) {
      await notion.pages.update({
        page_id: existing.results[0].id,
        properties: bookingProps,
      });
    } else {
      await notion.pages.create({
        parent: { database_id: DATABASE_ID },
        properties: {
          Name: { title: [{ text: { content: name || 'Unknown' } }] },
          Email: { email },
          ...bookingProps,
        },
      });
    }

    return res.status(200).send('OK');
  } catch (err) {
    console.error('Notion update failed:', err);
    return res.status(500).send('Internal Server Error');
  }
};