# Imbali Cal.com → Notion Webhook

A small serverless function that listens for paid consultation bookings on 
Cal.com and automatically creates a matching lead record in the Imbali 
Web Studio Notion CRM.

## What it does

When a client books and pays for the $39 consultation on the `45min` 
Cal.com event, Cal.com sends a `BOOKING_PAID` webhook to this function. 
The function verifies the request actually came from Cal.com (if a signing 
secret is configured), pulls the client's name, email, phone, business 
name, notes, and quoted package/price/deposit (captured as hidden 
booking-question fields prefilled from the booking page's URL), then 
creates a new page in the Notion CRM database with those fields filled in 
and Lead Status set to "Booked."

All other webhook events (test pings, booking created/cancelled, etc.) 
are received but ignored.

## Setup

1. Deploy this repo to Vercel (no build configuration needed — uses 
   plain `fetch`, no dependencies to install).
2. In the Vercel project's Environment Variables, add:
   - `NOTION_API_KEY` — Notion integration token
   - `NOTION_DATABASE_ID` — target CRM database ID
   - `CAL_WEBHOOK_SECRET` — optional, see "Security" below
3. In Cal.com (Settings → Developer → Webhooks), point a webhook at:
   `https://<your-vercel-project>.vercel.app/api/cal-webhook`
   with the **Booking Paid** trigger enabled.

## Notion field mapping

| Cal.com response field | Notion property      | Notion type |
|--------------------------|------------------------|-------------|
| `name`                  | Name                  | Title       |
| `email`                  | Email                  | Email       |
| `attendeePhoneNumber`    | Phone                  | Phone number|
| `Business-Name`         | Business Name         | Text        |
| `notes`                  | Business Notes        | Text        |
| `package`                | Tier                   | Select      |
| `price`                  | Total Quote            | Number      |
| `deposit`                | Deposit 40%             | Number      |
| _(hardcoded)_            | Lead Status → Booked  | Select      |

`package`, `price`, and `deposit` are hidden custom booking questions on 
the Cal.com event, prefilled via the booking page's URL params 
(`?package=growth&price=3250&deposit=1300`) using Cal.com's 
`forwardQueryParams` feature.

## Security

This endpoint verifies Cal.com's webhook signature (`x-cal-signature-256`) 
using HMAC-SHA256 over the raw request body, if `CAL_WEBHOOK_SECRET` is 
set. To enable it:
1. In Cal.com: Settings → Developer → Webhooks → your webhook → add a 
   Secret.
2. In Vercel: add the same value as `CAL_WEBHOOK_SECRET`.

Until both are set, signature verification is skipped and the endpoint 
will accept any POST request — fine for initial testing, but worth 
locking down before relying on this long-term.
