const product = Object.freeze({
  en: 'Maya Reception',
  fr: 'Réception Maya',
  'fr-CA': 'Réception Maya',
});

export const BRAND = Object.freeze({
  product,
  defaultPersonaName: 'Maya',
});

export function getProductName(locale: string): string {
  return locale === 'fr' || locale.toLowerCase().startsWith('fr-') ? BRAND.product['fr-CA'] : BRAND.product.en;
}
