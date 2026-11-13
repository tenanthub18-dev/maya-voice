const BIDI_CONTROL_CHARACTERS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

export function stripBidiControls(value: string): string {
  return value.replace(BIDI_CONTROL_CHARACTERS, '');
}

export function emailHeaderText(value: string): string {
  return stripBidiControls(value).replace(/[\r\n]+/gu, ' ').trim();
}
