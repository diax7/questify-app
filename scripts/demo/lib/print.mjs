// The printable sheet of the demo event's codes: the join code and the /play link, every quest and passport-step QR,
// the secret room's code and the two entry codes. One self-contained HTML file (inline SVG, no network), A4, in
// English and Arabic. Open it in a browser and print, or show it on a laptop screen and scan from there.
import { createRequire } from "node:module";

// The web app's own QR encoder (uqr, already a dependency there); no new package.
const require = createRequire(new URL("../../../apps/web/package.json", import.meta.url));
const { renderSVG } = require("uqr");

const escape = (text) =>
  String(text ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

const qr = (url) => renderSVG(url, { border: 1, ecc: "M" });

function card({ en, ar, note, url, big }) {
  return `<figure class="card">
  ${url === undefined ? "" : qr(url)}
  ${big === undefined ? "" : `<div class="big">${escape(big)}</div>`}
  <figcaption><strong>${escape(en)}</strong><span dir="rtl" lang="ar">${escape(ar)}</span>${
    note === undefined ? "" : `<small>${escape(note)}</small>`
  }</figcaption>
</figure>`;
}

function questCards(codes) {
  return codes.codes.map((code) =>
    card({
      en: code.step === null ? code.title.en : `${code.title.en}: ${code.step.en}`,
      ar: code.step === null ? code.title.ar : `${code.title.ar}: ${code.step.ar}`,
      note: code.step === null ? code.category.en : "Passport stamp",
      url: code.url,
    }),
  );
}

function startCards(demo, web) {
  return [
    card({
      en: "Play in the browser",
      ar: "العب في المتصفح",
      note: `${web}/play`,
      url: `${web}/play`,
    }),
    card({
      en: "Join code",
      ar: "رمز الانضمام",
      note: `${web}/en/e/${demo.joinCode}`,
      url: `${web}/en/e/${demo.joinCode}`,
      big: demo.joinCode,
    }),
    card({
      en: "Secret word (type it)",
      ar: "الكلمة السرية (اكتبها)",
      big: demo.entryCodes.secretWord,
    }),
  ];
}

function secretCards(demo) {
  return [
    ...demo.codes.secrets.map((secret) =>
      card({
        en: `Reveal: ${secret.category.en}`,
        ar: `اكشف: ${secret.category.ar}`,
        note: "Scan to show the hidden category",
        url: secret.url,
      }),
    ),
    card({
      en: "Vault code (type it)",
      ar: "رمز الخزنة (اكتبه)",
      note: "In the secret room",
      big: demo.entryCodes.vault,
    }),
  ];
}

const STYLE = `
  @page { size: A4; margin: 12mm; }
  body { font-family: Rubik, system-ui, sans-serif; color: #2b1d0e; background: #fbf4e4; margin: 16px; }
  h1 { font-size: 20px; margin: 0 0 4px; } h2 { font-size: 15px; margin: 20px 0 8px; break-after: avoid; }
  p { margin: 0 0 8px; font-size: 13px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 10px; }
  .card { margin: 0; padding: 10px; border: 2px solid #8a5a2b; border-radius: 10px; background: #fff; break-inside: avoid; text-align: center; }
  .card svg { width: 140px; height: 140px; }
  .big { font-size: 26px; font-weight: 700; letter-spacing: 2px; margin: 8px 0; }
  figcaption { display: flex; flex-direction: column; gap: 2px; font-size: 13px; }
  small { color: #6b5233; word-break: break-all; }
  @media print { body { background: #fff; margin: 0; } }`;

/** The whole sheet as one HTML document. `web` is the dashboard's origin (where /play and /e/ live). */
export function qrSheet(demo, { web }) {
  const name = demo.eventName ?? {
    en: "Questify Full Demo",
    ar: "عرض كويستفاي الكامل",
  };
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Demo codes</title><style>${STYLE}</style></head>
<body>
<h1>${escape(name.en)} · <span dir="rtl" lang="ar">${escape(name.ar)}</span></h1>
<p>Join code <strong>${escape(demo.joinCode)}</strong>. Scan the quest codes from inside the app (Scan button), not the phone camera.</p>
<h2>Start here</h2><div class="grid">${startCards(demo, web).join("\n")}</div>
<h2>Quest and passport codes</h2><div class="grid">${questCards(demo.codes).join("\n")}</div>
<h2>The secret room</h2><div class="grid">${secretCards(demo).join("\n")}</div>
</body></html>
`;
}
