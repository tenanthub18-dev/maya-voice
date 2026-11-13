// Next's font loader supports test CSS through this response map:
// https://github.com/vercel/next.js/blob/v16.4.3/packages/font/src/google/fetch-css-from-google-fonts.ts
const face = (family, subset, file) => `
/* ${subset} */
@font-face {
  font-family: '${family}';
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: url(https://fonts.gstatic.com/${file}.woff2) format('woff2');
}`;

module.exports = {
  'https://fonts.googleapis.com/css2?family=Inter:wght@100..900&display=swap':
    face('Inter', 'latin', 'e2e-inter'),
  'https://fonts.googleapis.com/css2?family=Noto+Nastaliq+Urdu:wght@400..700&display=swap':
    face('Noto Nastaliq Urdu', 'arabic', 'e2e-nastaliq'),
  'https://fonts.googleapis.com/css2?family=Noto+Sans+Devanagari:wght@100..900&display=swap':
    face('Noto Sans Devanagari', 'devanagari', 'e2e-devanagari'),
  'https://fonts.googleapis.com/css2?family=Noto+Sans+Gurmukhi:wght@100..900&display=swap':
    face('Noto Sans Gurmukhi', 'gurmukhi', 'e2e-gurmukhi'),
};
