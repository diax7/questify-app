import { z } from "zod";

/**
 * The support contact details an admin edits (T-706, FR-1731): a WhatsApp number, a phone number and an email, each
 * optional. The contact page, the app and the legal drafts' contact placeholders show what is set and nothing else.
 */

/** International format, digits only after the plus: the form wa.me and tel: links take. */
export const SUPPORT_PHONE = /^\+[1-9][0-9]{7,14}$/;
export const SUPPORT_EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;
export const SUPPORT_EMAIL_MAX = 254;

const phone = z.string().regex(SUPPORT_PHONE).nullable();
const email = z.string().max(SUPPORT_EMAIL_MAX).regex(SUPPORT_EMAIL).nullable();

/** What an admin saves, and what the public reads. */
export const supportContactSchema = z.strictObject({
  whatsapp: phone,
  phone,
  email,
});
export type SupportContact = z.infer<typeof supportContactSchema>;

export const supportContactAdminSchema = z.strictObject({
  ...supportContactSchema.shape,
  updatedAt: z.string().nullable(),
});
export type SupportContactAdmin = z.infer<typeof supportContactAdminSchema>;

/** The chat link of a WhatsApp number (digits only, no plus). */
export const whatsappLink = (number: string): string => `https://wa.me/${number.slice(1)}`;
