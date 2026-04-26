import { NextApiRequest, NextApiResponse } from 'next';
import Stripe from 'stripe';

/**
 * PR-Reviewer: Per-Seat Stripe Subscription
 * 
 * Pain Point: We need to monetize based on team size to scale MRR effectively.
 * 
 * Solution: This endpoint creates a Checkout Session where the quantity equals 
 * the number of developer seats requested by the Engineering Manager.
 */

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2023-10-16',
});

// The B2D SaaS pricing tier: $15/mo per developer
const PER_SEAT_PRICE_ID = 'price_pr_reviewer_15_mo'; 

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  try {
    const { orgId, orgEmail, seatCount } = req.body;

    console.log(`[PR-Reviewer] 💳 Initiating Per-Seat Checkout for Org: ${orgId}`);
    console.log(`[PR-Reviewer] Seats Requested: ${seatCount} | Total MRR: $${seatCount * 15}/mo`);

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price: PER_SEAT_PRICE_ID,
          quantity: seatCount,
        },
      ],
      mode: 'subscription',
      success_url: `${process.env.NEXT_PUBLIC_BASE_URL}/org-setup?success=true`,
      cancel_url: `${process.env.NEXT_PUBLIC_BASE_URL}/org-setup?canceled=true`,
      customer_email: orgEmail,
      metadata: {
        organizationId: orgId,
        seats: seatCount.toString()
      }
    });

    console.log(`[PR-Reviewer] ✅ Stripe Subscription Session Created: ${session.id}`);

    return res.status(200).json({ url: session.url });

  } catch (error) {
    console.error("[PR-Reviewer] Stripe Checkout Failure:", error);
    return res.status(500).json({ error: 'Failed to initialize per-seat billing.' });
  }
}
