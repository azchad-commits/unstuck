// Dayfall Plus — Stripe webhook (Supabase Edge Function).
// checkout.session.completed → set profiles.plus = true for the account whose auth email
// matches the payer's email. Deploy with:
//   supabase functions deploy stripe-webhook --no-verify-jwt
// Secrets (supabase secrets set KEY=value):
//   STRIPE_SECRET_KEY      sk_live_... (Stripe → Developers → API keys)
//   STRIPE_WEBHOOK_SECRET  whsec_...  (Stripe → Webhooks → this endpoint's signing secret)
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically by the platform.
import Stripe from "npm:stripe@14";
import { createClient } from "npm:@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!);
const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

Deno.serve(async (req) => {
  const sig = req.headers.get("stripe-signature");
  if (!sig) return new Response("missing signature", { status: 400 });
  const body = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, sig, Deno.env.get("STRIPE_WEBHOOK_SECRET")!);
  } catch {
    return new Response("bad signature", { status: 400 });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const email = session.customer_details?.email?.toLowerCase();
    if (email) {
      // Match by auth email. Fine at small scale; page through when users grow.
      let page = 1, found = null;
      while (!found && page <= 10) {
        const { data, error } = await supa.auth.admin.listUsers({ page, perPage: 200 });
        if (error || !data?.users?.length) break;
        found = data.users.find((u) => u.email?.toLowerCase() === email) ?? null;
        page++;
      }
      if (found) {
        await supa.from("profiles").upsert({ user_id: found.id, plus: true });
        console.log("plus activated:", email);
      } else {
        // Paid before creating an account: log it so it can be granted manually
        // (or they tap "check again" after signing up and support flips the row).
        console.warn("paid but no matching auth user yet:", email);
      }
    }
  }
  return new Response("ok");
});
