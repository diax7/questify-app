const GSM_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXTENDED = "\f^{}\\[~]|€";

/** The SMS septets of a text in the GSM 7-bit alphabet, or null when it needs UCS-2. */
function gsmSeptets(text: string): number | null {
  let septets = 0;
  for (const char of text) {
    if (GSM_BASIC.includes(char)) septets += 1;
    else if (GSM_EXTENDED.includes(char)) septets += 2;
    else return null;
  }
  return septets;
}

/** How many SMS parts a text takes: GSM-7 160 alone or 153 a part, else UCS-2 70 alone or 67 a part (UTF-16 units). */
export function smsParts(text: string): number {
  const septets = gsmSeptets(text);
  if (septets !== null) return septets <= 160 ? 1 : Math.ceil(septets / 153);
  return text.length <= 70 ? 1 : Math.ceil(text.length / 67);
}
