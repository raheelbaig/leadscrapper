import { z } from "zod";

import { createSearchSchema } from "@/lib/schemas/search";

/**
 * The guided flow's request shapes, shared between the form and the routes.
 *
 * Built by EXTENDING `createSearchSchema` rather than restating it, so the
 * guided page and the advanced Find Leads page cannot drift into accepting
 * different things. The one field the guided flow adds is the consent.
 */

export const createGenerationSchema = createSearchSchema.extend({
  /**
   * Consent to fetch pages from the leads' OWN websites in search of a contact
   * address.
   *
   * Defaults to true because the guided flow states it plainly on the form
   * ("We'll check public business websites for contact emails") and in the
   * pre-flight summary before anything is approved. A default is only
   * acceptable while it is visible, which is why it is a checkbox the user can
   * see and clear rather than an assumption made for them.
   *
   * The BOOLEAN is only a request. What governs the run is the timestamp the
   * server writes to `generation_runs.enrichment_consented_at`, and the
   * orchestrator reads that row -- never this field -- before making a single
   * external request.
   */
  enrichEmails: z.boolean().default(true),
});

export type CreateGenerationInputValues = z.input<typeof createGenerationSchema>;
export type CreateGenerationValues = z.output<typeof createGenerationSchema>;

/** A fresh approval over a search that already exists. */
export const continueGenerationSchema = z.object({
  searchId: z.string().uuid(),
  enrichEmails: z.boolean().default(true),
});
